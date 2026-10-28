module.exports = {
  preset: 'react-native',
  // Agent worktrees hold full copies of the repo.
  modulePathIgnorePatterns: ['<rootDir>/.claude/'],
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/.claude/'],
};
