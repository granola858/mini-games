# Workspace Rules

## Git Commit & Push 工作流程規範

當使用者要求 "commit & push" 或提交變更時，請依據以下標準步驟執行：
1. **檢查狀態**: 執行 `git status` 確認所有已被修改或新增的檔案。
2. **暫存變更**: 執行 `git add` 將目標變更納入暫存區。
3. **撰寫 Commit Message**:
   - 採用 **Conventional Commits** 格式前綴（例如：`feat:`, `fix:`, `style:`, `refactor:`, `docs:`）。
   - 遵循 `user_global` 規則，內容摘要**一律使用繁體中文（台灣）**撰寫。
   - 範例：`feat(nonogram): 新增盤面鎖定防誤觸與螢幕防休眠設定`
4. **推送遠端**: 執行 `git push` 將本機 commit 推送至當前分支。
