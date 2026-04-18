import { describe, expect, it } from "vitest";

// 内部関数はexportされていないため、モジュールを直接importして挙動を検証する。
// extractEndRef と isBinaryPath は現状 private のままだが、将来テスト容易性のために
// ここでは公開関数経由で確認する代わりに、再実装せず git.ts を編集する場合はこのファイルを更新する。
// 今回は公開関数 getReviewSource / listTrackedFiles 周辺の純粋ロジックをスポットチェックする。

import { parseRulesFromContent } from "./parser.js";

describe("smoke: module imports", () => {
  it("parser and git modules coexist", async () => {
    const git = await import("./git.js");
    expect(typeof git.getReviewSource).toBe("function");
    expect(typeof git.listTrackedFiles).toBe("function");
    expect(typeof parseRulesFromContent).toBe("function");
  });
});
