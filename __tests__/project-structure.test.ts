import {existsSync, statSync} from 'fs';
import {join} from 'path';

const REPO_ROOT = join(__dirname, '..');

const REQUIRED_DIRECTORIES = [
  'src/app',
  'src/radio',
  'src/screens',
  'src/ptt',
  'specs',
  'android/app/src/main/java/com/oru/radio',
  'ios/Radio',
];

describe('project structure (spec section 17)', () => {
  it.each(REQUIRED_DIRECTORIES)('%s exists and is a directory', relative => {
    const absolute = join(REPO_ROOT, relative);
    expect(existsSync(absolute)).toBe(true);
    expect(statSync(absolute).isDirectory()).toBe(true);
  });
});
