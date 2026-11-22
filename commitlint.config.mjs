/**
 * Conventional commit policy for blaze-cache.
 *
 * Extends the standard conventional types and adds `bench`, which this repo uses for benchmark
 * suites, baseline JSON and measurement tooling. Everything else stays conventional so the
 * changelog and release notes remain machine-readable.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'bench',
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
      ],
    ],
  },
};
