import { randomInt as cryptoRandomInt } from 'node:crypto';
import { join } from 'node:path';
import { read, save } from './state.js';

export const POLL_DURATION_MS = 60 * 60 * 1000;
export const MAX_POLL_OPTIONS = 20;
export const MAX_OPTION_LENGTH = 100;

const locks = new Map();

function withRecordingLock(dir, task) {
  const key = String(dir);
  const previous = locks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  locks.set(key, current);
  current.finally(() => {
    if (locks.get(key) === current) locks.delete(key);
  }).catch(() => {});
  return current;
}

export function recordingMetaPath(dir) {
  return join(dir, 'recording.json');
}

export function cleanOptionLabel(raw) {
  return String(raw ?? '').replace(/\r?\n/g, ' ').trim();
}

export function normalizeOptionKey(raw) {
  return cleanOptionLabel(raw).normalize('NFC').toLowerCase();
}

export function optionVoteCount(option) {
  const voters = Array.isArray(option?.voters) ? option.voters.length : 0;
  return voters + (option?.initialSystemVote ? 1 : 0);
}

export function pollRemainingMs(poll, now = Date.now()) {
  if (!poll || poll.status !== 'open') return 0;
  const endsAt = Date.parse(poll.endsAt);
  if (!Number.isFinite(endsAt)) return 0;
  return Math.max(0, endsAt - now);
}

export function isPollOpen(poll, now = Date.now()) {
  return Boolean(poll && poll.status === 'open' && Date.parse(poll.endsAt) > now);
}

export function selectPollWinner(poll, randomInt = cryptoRandomInt) {
  const options = Array.isArray(poll?.options) ? poll.options : [];
  if (!options.length) throw new Error('A enquete não possui opções.');

  let maxVotes = -1;
  for (const option of options) {
    const count = optionVoteCount(option);
    if (count > maxVotes) maxVotes = count;
  }

  const tied = options.filter((option) => optionVoteCount(option) === maxVotes);
  let winner;
  let tieBreakReason;

  if (tied.length === 1) {
    winner = tied[0];
    tieBreakReason = 'highest';
  } else {
    const tiedCustom = tied.filter((option) => option.kind === 'custom');
    if (tiedCustom.length === 1) {
      winner = tiedCustom[0];
      tieBreakReason = 'custom_priority';
    } else if (tiedCustom.length > 1) {
      tiedCustom.sort((a, b) => {
        const orderDiff = (a.createdOrder ?? 0) - (b.createdOrder ?? 0);
        if (orderDiff !== 0) return orderDiff;
        return Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0);
      });
      winner = tiedCustom[0];
      tieBreakReason = 'earliest_custom';
    } else {
      const index = randomInt(tied.length);
      if (!Number.isInteger(index) || index < 0 || index >= tied.length) {
        throw new Error('Índice de sorteio inválido.');
      }
      winner = tied[index];
      tieBreakReason = 'random_suggested';
    }
  }

  return {
    optionId: winner.id,
    label: winner.label,
    kind: winner.kind,
    votes: optionVoteCount(winner),
    tieBreakReason,
  };
}

function loadRecordingMeta(dir) {
  const path = recordingMetaPath(dir);
  const meta = read(path, null);
  if (!meta) throw new Error('Gravação não encontrada.');
  return { path, meta };
}

export async function openRecordingPoll(dir, {
  suggestions = [],
  initialTitle,
  initialTitleBy,
  durationMs = POLL_DURATION_MS,
  now = Date.now,
} = {}) {
  return withRecordingLock(dir, () => {
    const { path, meta } = loadRecordingMeta(dir);
    if (meta.poll) {
      return { meta, poll: meta.poll, created: false };
    }

    const openedMs = now();
    const openedAt = new Date(openedMs).toISOString();
    const endsAt = new Date(openedMs + durationMs).toISOString();
    const options = [];
    const seen = new Set();
    let nextOrder = 0;
    let nextOptionSeq = 1;

    const pushOption = ({ label, kind, createdBy = null, initialSystemVote = false, voters = [] }) => {
      const clean = cleanOptionLabel(label);
      if (!clean || clean.length > MAX_OPTION_LENGTH) return false;
      const key = normalizeOptionKey(clean);
      if (seen.has(key) || options.length >= MAX_POLL_OPTIONS) return false;
      seen.add(key);
      options.push({
        id: 'opt-' + nextOptionSeq++,
        label: clean,
        kind,
        createdAt: openedAt,
        createdOrder: nextOrder++,
        createdBy,
        initialSystemVote,
        voters: [...new Set(voters)],
      });
      return true;
    };

    const rawInitial = initialTitle !== undefined ? initialTitle : meta.sessionTitle;
    const rawAuthor = initialTitleBy !== undefined ? initialTitleBy : (meta.sessionTitleBy || null);
    const cleanInitial = cleanOptionLabel(rawInitial);
    if (cleanInitial) {
      const truncatedInitial = cleanInitial.slice(0, MAX_OPTION_LENGTH).trim();
      if (truncatedInitial) {
        pushOption({
          label: truncatedInitial,
          kind: 'custom',
          createdBy: rawAuthor || null,
          initialSystemVote: !rawAuthor,
          voters: rawAuthor ? [rawAuthor] : [],
        });
      }
    }

    for (const suggestion of Array.isArray(suggestions) ? suggestions : []) {
      const clean = cleanOptionLabel(suggestion);
      if (!clean) continue;
      pushOption({
        label: clean.slice(0, MAX_OPTION_LENGTH).trim(),
        kind: 'suggested',
        createdBy: null,
        initialSystemVote: false,
        voters: [],
      });
    }

    if (!options.length) {
      throw new Error('Nenhuma opção disponível para abrir a enquete.');
    }

    meta.poll = {
      version: 1,
      status: 'open',
      openedAt,
      endsAt,
      durationMs,
      nextOrder,
      nextOptionSeq,
      options,
      closedAt: null,
      winner: null,
    };

    save(path, meta);
    return { meta, poll: meta.poll, created: true };
  });
}

export async function voteRecordingPoll(dir, {
  optionId,
  userId,
  now = Date.now,
} = {}) {
  return withRecordingLock(dir, () => {
    const { path, meta } = loadRecordingMeta(dir);
    const poll = meta.poll;
    if (!poll || poll.status !== 'open' || Date.parse(poll.endsAt) <= now()) {
      return {
        ok: false,
        code: 'closed',
        changed: false,
        alreadyVoted: false,
        meta,
        poll: poll || null,
        message: 'A enquete já foi encerrada.',
      };
    }

    const option = poll.options.find((item) => item.id === optionId);
    if (!option) {
      return {
        ok: false,
        code: 'not_found',
        changed: false,
        alreadyVoted: false,
        meta,
        poll,
        message: 'Opção não encontrada.',
      };
    }

    option.voters = Array.isArray(option.voters) ? option.voters : [];
    if (option.voters.includes(userId)) {
      return {
        ok: true,
        changed: false,
        alreadyVoted: true,
        option,
        meta,
        poll,
        message: 'Você já votou em ‘' + option.label + '’. Você pode votar em outras opções também.',
      };
    }

    option.voters.push(userId);
    save(path, meta);
    return {
      ok: true,
      changed: true,
      alreadyVoted: false,
      option,
      meta,
      poll,
      message: 'Seu voto em ‘' + option.label + '’ foi registrado.',
    };
  });
}

export async function addRecordingPollOption(dir, {
  label,
  userId,
  now = Date.now,
} = {}) {
  return withRecordingLock(dir, () => {
    const { path, meta } = loadRecordingMeta(dir);
    const poll = meta.poll;
    if (!poll || poll.status !== 'open' || Date.parse(poll.endsAt) <= now()) {
      return {
        ok: false,
        code: 'closed',
        changed: false,
        duplicate: false,
        alreadyVoted: false,
        meta,
        poll: poll || null,
        message: 'A enquete já foi encerrada.',
      };
    }

    const clean = cleanOptionLabel(label);
    if (!clean) {
      return {
        ok: false,
        code: 'empty',
        changed: false,
        duplicate: false,
        alreadyVoted: false,
        meta,
        poll,
        message: 'Informe um nome.',
      };
    }

    if (clean.length > MAX_OPTION_LENGTH) {
      return {
        ok: false,
        code: 'too_long',
        changed: false,
        duplicate: false,
        alreadyVoted: false,
        meta,
        poll,
        message: 'Informe um nome com até ' + MAX_OPTION_LENGTH + ' caracteres.',
      };
    }

    const key = normalizeOptionKey(clean);
    const existing = poll.options.find((item) => normalizeOptionKey(item.label) === key);
    if (existing) {
      existing.voters = Array.isArray(existing.voters) ? existing.voters : [];
      if (existing.voters.includes(userId)) {
        return {
          ok: true,
          changed: false,
          duplicate: true,
          alreadyVoted: true,
          option: existing,
          meta,
          poll,
          message: 'Essa opção já existe e você já votou nela.',
        };
      }
      existing.voters.push(userId);
      save(path, meta);
      return {
        ok: true,
        changed: true,
        duplicate: true,
        alreadyVoted: false,
        option: existing,
        meta,
        poll,
        message: 'Essa opção já existe. Seu voto foi registrado nela.',
      };
    }

    if (poll.options.length >= MAX_POLL_OPTIONS) {
      return {
        ok: false,
        code: 'limit',
        changed: false,
        duplicate: false,
        alreadyVoted: false,
        meta,
        poll,
        message: 'A enquete atingiu o limite de opções. Você ainda pode votar nas opções existentes.',
      };
    }

    const createdAt = new Date(now()).toISOString();
    const nextOrder = Number.isInteger(poll.nextOrder) ? poll.nextOrder : poll.options.length;
    const nextOptionSeq = Number.isInteger(poll.nextOptionSeq) ? poll.nextOptionSeq : poll.options.length + 1;
    const option = {
      id: 'opt-' + nextOptionSeq,
      label: clean,
      kind: 'custom',
      createdAt,
      createdOrder: nextOrder,
      createdBy: userId,
      initialSystemVote: false,
      voters: [userId],
    };
    poll.nextOrder = nextOrder + 1;
    poll.nextOptionSeq = nextOptionSeq + 1;
    poll.options.push(option);
    save(path, meta);

    return {
      ok: true,
      changed: true,
      duplicate: false,
      alreadyVoted: false,
      option,
      meta,
      poll,
      message: 'Opção adicionada e seu voto registrado.',
    };
  });
}

export async function closeRecordingPoll(dir, {
  now = Date.now,
  randomInt = cryptoRandomInt,
  force = false,
} = {}) {
  return withRecordingLock(dir, () => {
    const { path, meta } = loadRecordingMeta(dir);
    const poll = meta.poll;
    if (!poll) throw new Error('Enquete não encontrada.');

    if (poll.status === 'closed' && poll.winner) {
      return {
        meta,
        poll,
        winner: poll.winner,
        alreadyClosed: true,
        pending: false,
        remainingMs: 0,
      };
    }

    const currentMs = now();
    const remainingMs = pollRemainingMs(poll, currentMs);
    if (!force && remainingMs > 0) {
      return {
        meta,
        poll,
        winner: null,
        alreadyClosed: false,
        pending: true,
        remainingMs,
      };
    }

    const winner = selectPollWinner(poll, randomInt);
    poll.status = 'closed';
    poll.closedAt = new Date(currentMs).toISOString();
    poll.winner = winner;
    save(path, meta);

    return {
      meta,
      poll,
      winner,
      alreadyClosed: false,
      pending: false,
      remainingMs: 0,
    };
  });
}

export async function restoreRecordingPoll(dir, {
  now = Date.now,
  randomInt = cryptoRandomInt,
  autoClose = true,
} = {}) {
  const path = recordingMetaPath(dir);
  const meta = read(path, null);
  if (!meta?.poll) return null;

  if (meta.poll.status === 'closed') {
    return {
      status: 'closed',
      meta,
      poll: meta.poll,
      winner: meta.poll.winner || null,
      remainingMs: 0,
      closedNow: false,
    };
  }

  const remainingMs = pollRemainingMs(meta.poll, now());
  if (remainingMs <= 0 && autoClose) {
    const closed = await closeRecordingPoll(dir, { now, randomInt, force: false });
    return {
      status: 'closed',
      meta: closed.meta,
      poll: closed.poll,
      winner: closed.winner,
      remainingMs: 0,
      closedNow: !closed.alreadyClosed,
    };
  }

  return {
    status: 'open',
    meta,
    poll: meta.poll,
    winner: null,
    remainingMs,
    closedNow: false,
  };
}

export function getPersistedPollWinner(dir) {
  const meta = read(recordingMetaPath(dir), null);
  if (!meta?.poll || meta.poll.status !== 'closed' || !meta.poll.winner) return null;
  return {
    ...meta.poll.winner,
    closedAt: meta.poll.closedAt || null,
    recordingId: meta.id,
  };
}
