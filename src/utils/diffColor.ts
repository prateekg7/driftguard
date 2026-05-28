export async function colorUnifiedDiff(diff: string): Promise<string> {
  const { Chalk } = await import('chalk');
  const chalk = new Chalk({ level: 1 });

  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        return chalk.green(line);
      }

      if (line.startsWith('-') && !line.startsWith('---')) {
        return chalk.red(line);
      }

      return line;
    })
    .join('\n');
}
