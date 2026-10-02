import fs from 'node:fs';
import assert from 'node:assert/strict';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, '正式版本号必须为 x.y.z');
assert.equal(lock.version, pkg.version, 'package-lock版本与package.json不一致');
assert.equal(lock.packages[''].version, pkg.version, 'lock根包版本不一致');
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`, '标签必须与版本一致，例如版本1.0.1对应v1.0.1');
}
console.log(`版本检查通过：${pkg.version}`);
