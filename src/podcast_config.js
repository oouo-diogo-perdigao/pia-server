import { pool, unseal } from './db.js';
import { runtime } from './connectors.js';

const BACKUP_PREFIX = 'PIA-BACKUP-PLAIN-1\n';
const CONFIG_DOCUMENT = 'Apps/podcast_automation/campaigns';

export async function resolvePodcastConfig(account, { workerReady = false } = {}) {
  const missing = [];
  if (!workerReady) missing.push('worker de Podcast Automation e contexto da API de IA');

  const { rows: [profile] } = await pool.query(
    'SELECT ciphertext FROM pia_server.profiles WHERE account_id=$1', [account.id],
  );
  let config;
  if (profile?.ciphertext) {
    const { backup } = JSON.parse(unseal(profile.ciphertext));
    const source = Buffer.from(backup, 'base64').toString('utf8');
    if (source.startsWith(BACKUP_PREFIX)) {
      const payload = JSON.parse(source.slice(BACKUP_PREFIX.length));
      const entry = payload.documents?.find(([name]) => name === CONFIG_DOCUMENT);
      if (entry) config = JSON.parse(entry[1]);
    }
  }
  if (!config?.campaign_details || !Object.keys(config.campaign_details).length) missing.push('campanha');
  const { storage_account: accountId, storage_bucket: selectedBucket } = config?.integrations || {};
  if (!accountId) return { missing: [...missing, 'bucket/Object Storage'] };

  const connector = await runtime(account, 'object_storage', accountId);
  const destination = connector.config.accounts?.find((item) => item.id === accountId);
  const bucket = selectedBucket || destination?.bucket;
  const { access_key: accessKeyId, secret_key: secretAccessKey } = connector.secret || {};
  if (!bucket || !destination?.endpoint || !accessKeyId || !secretAccessKey) {
    return { missing: [...missing, 'bucket/Object Storage'] };
  }
  if (missing.length) return { missing };
  return {
    missing,
    value: {
      id: String(account.id),
      config,
      storage: {
        accountId,
        bucket,
        publicUrl: destination.public_url,
        endpoint: destination.endpoint,
        region: destination.region,
        accessKeyId,
        secretAccessKey,
      },
    },
  };
}
