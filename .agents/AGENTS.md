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

## 遊戲進度與偏好持久化規範 (State Persistence Standard)

所有新增或維護的小遊戲**必須實作完整的前端持久化（localStorage）**，避免使用者重整或意外離開頁面時遺失遊戲進度：

1. **進行中局況保存 (In-Progress Game State)**：
   - 每個遊戲必須具備 `saveGameState()`、`loadGameState()` 與 `clearGameState()` 生命週期方法。
   - 應保存的進行中狀態包括：難度規格、盤面/手牌/棋盤資料、已花費秒數、步數/連勝/猜測歷史、操作進度等。
   - 頁面初始化（`init()`）時，優先呼叫 `loadGameState()` 恢復未完成的局況；若無存檔或已獲勝則開啟新局。
   - 玩家獲勝（`handleWin()`）或主動重置（`restart`/`newGame`）時，須呼叫 `clearGameState()` 清除或覆寫舊局況。

2. **歷史紀錄與統計 (Player Stats & Records)**：
   - 持久化玩家的最高連勝（best streak）、最快通關時間（best time）、最少步數（least moves）與通關次數等。

3. **偏好設定 (User Preferences)**：
   - 主題色切換（相容首頁 `bobo-home-preferences-v2` 與遊戲本身的 `xxx_theme`）。
   - 音效開關設定（`xxx_sound` 或 `xxx-muted`）。

4. **防禦性錯誤處理 (Error Handling)**：
   - 所有 `localStorage` 操作（讀取、寫入、刪除）一律使用 `try...catch` 包裹，防止隱私模式或 JSON 解析失敗引發崩潰。
