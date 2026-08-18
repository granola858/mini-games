# 猜歌資料庫 (guess-song)

波波小遊戲合輯中唯一使用建置流程的遊戲，以 React + Vite 開發。
其餘遊戲皆為免建置的原生 HTML/CSS/JS，直接放在 `games/<遊戲名>/`。

## 開發

```bash
npm install
npm run dev
```

## 建置

```bash
npm run build
```

## ⚠️ `dist/` 是刻意提交進版控的

全站以 GitHub Pages 直接託管靜態檔案，沒有 CI 建置步驟，
首頁的猜歌卡片直接連向 `games/guess-song/dist/index.html`。

因此**修改 `src/` 之後必須重新執行 `npm run build` 並一併提交 `dist/`**，
否則線上版本不會更新。

根目錄 `.gitignore` 雖然列有 `dist/`，但本專案的 `dist/` 已被強制加入追蹤，
這是為了免建置部署所做的取捨。
