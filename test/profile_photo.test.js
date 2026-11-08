import assert from 'node:assert/strict';
import test from 'node:test';
import { accountProfile, googlePicture } from '../src/auth.js';

test('Google avatar accepts only an HTTPS profile image on the Google image host', () => {
  const picture = 'https://lh3.googleusercontent.com/a/example';
  assert.deepEqual(accountProfile({ email: 'fixture@example.invalid', google_picture: picture, drive_refresh: 'fixture-secret' }),
    { email: 'fixture@example.invalid', picture });
  for (const bad of ['http://lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com.evil.invalid/a',
    'https://user@lh3.googleusercontent.com/a', 'https://lh3.googleusercontent.com:444/a', 'not-a-url', null]) {
    assert.equal(googlePicture(bad), null);
  }
});
