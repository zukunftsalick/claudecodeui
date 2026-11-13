import assert from 'node:assert/strict';

import { test } from 'vitest';

import { readAgentEditedFilePath } from '@/modules/chat/utils/agentFileEdits';

test('readAgentEditedFilePath returns the target of file-writing tools', () => {
  assert.equal(readAgentEditedFilePath('Edit', { file_path: '/repo/README.md' }), '/repo/README.md');
  assert.equal(readAgentEditedFilePath('Write', { file_path: '/repo/index.html', content: '<p>' }), '/repo/index.html');
  assert.equal(readAgentEditedFilePath('MultiEdit', { file_path: '/repo/a.ts' }), '/repo/a.ts');
  assert.equal(readAgentEditedFilePath('NotebookEdit', { notebook_path: '/repo/n.ipynb' }), '/repo/n.ipynb');
});

test('readAgentEditedFilePath ignores read-only tools and malformed input', () => {
  assert.equal(readAgentEditedFilePath('Read', { file_path: '/repo/a.ts' }), null);
  assert.equal(readAgentEditedFilePath('Bash', { command: 'ls' }), null);
  assert.equal(readAgentEditedFilePath('Edit', null), null);
  assert.equal(readAgentEditedFilePath('Edit', { file_path: '   ' }), null);
  assert.equal(readAgentEditedFilePath(undefined, { file_path: '/repo/a.ts' }), null);
});
