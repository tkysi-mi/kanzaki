# Changelog

## 0.3.2

### Breaking changes (bundled in patch)

- **Node.js 20.6+ が必須**になりました。Node 18/19 は install できません。
  - 理由: `process.loadEnvFile()` (Node 20.6+) 利用のため。`dotenv` 依存を削除。

### Dependencies

- **Removed**: `dotenv` (Node 標準 API で代替)
- **Replaced**: `chalk` → `picocolors` (軽量・ESM-native)
- **Bumped**: `@anthropic-ai/sdk` `^0.39` → `^0.90`
- **Bumped**: `openai` `^4.85` → `^6.x`
- **Added (devDep)**: `@types/node` (SDK 更新で transitive 依存から外れたため明示化)
- **Added (devDep)**: `@biomejs/biome` (lint + format を 1 ツールに統合)

### Tooling

- **Biome 導入**: `npm run lint` / `npm run format` / `npm run check` を追加
- **GitHub Actions** `.github/workflows/ci.yml` 追加 — Node 20/22/24 × Ubuntu, Node 22 × Windows
- **GitHub Actions** `.github/workflows/release.yml` 追加 — タグ push で自動 npm publish

### Internal

- `tsconfig.json` から未使用の `declaration` / `declarationMap` を削除
- `tsup` `target` を `node18` → `node20` に更新

## 0.3.1

- Fix: bin path normalization in package.json (`./dist/bin.js` → `dist/bin.js`)

## 0.3.0

- Initial public release baseline.
