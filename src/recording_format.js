const filenamePart = (value, fallback) => {
  const clean = String(value || '').normalize('NFC').replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/g, '').slice(0, 45);
  return clean && !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(clean) ? clean : fallback;
};

const archiveClock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23',
});

export function recordingName(guild, room, date) {
  return filenamePart(guild, 'Discord') + archiveClock.format(date).replace(/\D/g, '') +
    '-' + filenamePart(room, 'voz') + '.aup.zip';
}

export function recordingTracks(meta) {
  const taken = new Set();
  return meta.tracks.map((id, index) => {
    const username = meta.usernames?.[id];
    const label = username || id;
    let filename = username ? filenamePart(username, id) : (index + 1) + '-' + id;
    if (taken.has(filename.toLowerCase())) filename += '-' + id;
    taken.add(filename.toLowerCase());
    return { id, username: label, filename: filename + '.flac' };
  });
}

const xml = (value) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character]);

export function audacityProject(tracks) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<project xmlns="http://audacity.sourceforge.net/xml/" projname="pia_data" version="1.3.0" audacityversion="2.4.2" rate="48000">\n' +
    tracks.map(({ filename, username }) => '  <import filename="' + xml(filename) +
      '" name="' + xml(username) + '" offset="0"/>').join('\n') +
    '\n</project>\n';
}

export const recordingFolder = (account) => account.recording_folder_id || account.folder_id;
