/**
 * Normalize program output according to CODE RUSH's strict comparison policy:
 * - Convert CRLF to LF
 * - Ignore trailing spaces and tabs at the end of individual lines
 * - Ignore trailing empty lines at the end of output
 * - Preserve leading spaces, internal spaces, internal line breaks, and case
 */
export function normalizeProgramOutput(raw) {
  if (typeof raw !== 'string') {
    return '';
  }

  const lf = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = lf.split('\n').map((line) => line.replace(/[ \t]+$/g, ''));

  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * Compare actual Judge0 stdout against expected test case output deterministically.
 */
export function compareOutputs(actualOutput, expectedOutput) {
  const normalizedActual = normalizeProgramOutput(actualOutput);
  const normalizedExpected = normalizeProgramOutput(expectedOutput);

  return {
    matched: normalizedActual === normalizedExpected,
    normalizedActual,
    normalizedExpected
  };
}
