/**
 * Eval 评分器（HD-11）：纯函数，便于 `node evals/grade-check.mjs` 自测。
 * 评分只看模型输出，不调用模型，也不依赖任何产品代码。
 */

export function parseChoice(output) {
  const text = String(output ?? '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.choice === 'string') return parsed.choice.trim();
  } catch {
    // 不是 JSON：退化成整段文本
  }
  return text.replace(/^["'“”]+|["'“”]+$/gu, '').trim();
}

/** 选择类 case：模型必须选出 expected。 */
export function gradeChoice(caseDef, output) {
  const actual = parseChoice(output);
  return { pass: actual === caseDef.expected, actual, expected: caseDef.expected };
}

/** 标题类 case：必须包含全部关键词，且不超过长度上限。 */
export function gradeTitle(caseDef, output) {
  const actual = String(output ?? '')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const missing = (caseDef.mustInclude ?? []).filter(
    (keyword) => !actual.toLowerCase().includes(String(keyword).toLowerCase()),
  );
  const tooLong = actual.length > (caseDef.maxLength ?? 60);
  return { pass: actual.length > 0 && missing.length === 0 && !tooLong, actual, missing, tooLong };
}

export function grade(caseDef, output) {
  return caseDef.kind === 'title' ? gradeTitle(caseDef, output) : gradeChoice(caseDef, output);
}
