import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const directory = '.runtime/workflow';
export const pendingFile = join(directory, 'pending.json');
export const contextFile = join(directory, 'last-failure.json');
export const read = path => JSON.parse(readFileSync(path, 'utf8'));

export function excerpt(value) {
  const text = stripVTControlCharacters(String(value)).replace(/(\w+:\/\/[^\s/@:]+:)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(Bearer\s+|(?:password|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');
  return text.length <= 6000 ? text : text.slice(0, 3000) + '\n…\n' + text.slice(-3000);
}

export function writeRecord(path, data, exclusive = false) {
  mkdirSync(directory, { recursive: true });
  const temp = join(directory, randomUUID() + '.tmp');
  writeFileSync(temp, JSON.stringify(data, null, 2), { flag: 'wx' });
  try {
    if (exclusive) linkSync(temp, path);
    else renameSync(temp, path);
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

export function openQuestion(scope, question) {
  const issue = { id: randomUUID(), scope, question: excerpt(question), created: new Date().toISOString() };
  writeRecord(pendingFile, issue);
  return issue;
}

export const replyPath = issue => join(directory, issue.id + '.reply.json');
export function reply(id, answer) {
  const issue = existsSync(pendingFile) && read(pendingFile);
  if (!issue || issue.id !== id) throw Error('問題編號已過期，請重新讀取目前問題。');
  if (!answer.trim()) throw Error('回覆不可空白。');
  writeRecord(replyPath(issue), { answer: answer.trim() }, true);
}
