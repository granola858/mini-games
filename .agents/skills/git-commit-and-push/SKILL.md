---
name: git-commit-and-push
description: 自動檢查 git status、暫存變更、生成 Conventional Commits 格式與繁體中文（台灣）描述的 Commit Message 並執行 git push 的完整流程。適用於使用者要求 "commit and push"、"commit & push"、"提交並推送" 時。
---

# Git Commit & Push Workflow

當使用者要求 commit 與 push 變更時，請依據以下標準流程執行：

## 執行步驟

1. **檢查 Git 狀態**:
   執行 `git status` 檢視所有已被修改或新增的檔案。

2. **暫存變更**:
   執行 `git add .` （或針對目標檔案進行 `git add`）將變更寫入暫存區。

3. **撰寫 Commit Message**:
   - 格式採用 **Conventional Commits** 前綴：
     - `feat`: 新增功能 / 優化
     - `fix`: 修復 Bug / 錯誤
     - `style`: 樣式、排版或視覺微調
     - `refactor`: 重構或程式碼優化
     - `docs`: 文件或註解說明
     - `chore`: 設定或建置維護
   - 內容摘要**一律使用繁體中文（台灣）**撰寫。
   - 範例命令：`git commit -m "feat(nonogram): 新增盤面鎖定防誤觸與螢幕防休眠設定"`

4. **推送遠端**:
   執行 `git push` 將本機 commit 推送至當前遠端分支。
