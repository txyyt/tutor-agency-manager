import { DatabaseSync } from 'node:sqlite';
import { unlinkSync, existsSync } from 'node:fs';
const d = new DatabaseSync(':memory:');
d.exec('PRAGMA journal_mode=WAL');
d.exec('PRAGMA foreign_keys=ON');
d.exec('CREATE TABLE t(a INTEGER PRIMARY KEY AUTOINCREMENT, b TEXT)');
d.prepare('INSERT INTO t(b) VALUES (?)').run('x');
console.log('sqlite_version', d.prepare('select sqlite_version() v').get().v);
if (existsSync('test-vacuum.db')) unlinkSync('test-vacuum.db');
d.exec("VACUUM INTO 'test-vacuum.db'");
console.log('VACUUM INTO ok');
const names = [];
let p = Object.getPrototypeOf(d);
while (p && p !== Object.prototype) { names.push(...Object.getOwnPropertyNames(p)); p = Object.getPrototypeOf(p); }
console.log('db methods:', [...new Set(names)].sort().join(','));
unlinkSync('test-vacuum.db');
