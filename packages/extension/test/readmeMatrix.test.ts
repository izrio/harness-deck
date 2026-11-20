import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { builtinProfiles } from '../src/backend/profiles.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('README 能力矩阵', () => {
  it('覆盖所有内置底层', () => {
    const section = readme.split('### 不同底层的差别')[1] ?? '';
    const header = section.split('\n').find((line) => line.startsWith('| 功能')) ?? '';
    for (const name of ['DeepSeek', 'Pi', 'ZCode', 'Claude', 'ACP']) {
      expect(header).toContain(name);
    }
    for (const profile of builtinProfiles(() => 'hint')) {
      expect(readme).toContain(profile.name);
    }
  });

  it('矩阵使用新的分组表头', () => {
    const section = readme.split('### 不同底层的差别')[1] ?? '';
    expect(section).not.toContain('| 功能 | DeepSeek | oh-my-pi |');
  });
});
