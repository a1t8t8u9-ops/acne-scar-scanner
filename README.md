# Acne Scar Scanner v0.3

スマートフォン向けPWA試作版です。

## 機能
- HTTPS環境でスマホカメラ起動
- 基準写真から顔検出
- ライブカメラから顔検出
- 顔中心 / 顔サイズ / 顔の傾きを比較
- 「右へ」「左へ」「近づいて」「離れて」などのリアルタイムガイド
- 基準写真のゴースト表示
- 撮影とBefore/After重ね合わせ
- PWA manifest / service worker

## 重要
`getUserMedia()` は HTTPS または localhost の安全なコンテキストが必要です。
GitHub Pages / Vercel等のHTTPS配信で使用してください。

## v0.4候補
- Face Meshによるyaw/pitch/roll推定
- 左右頬ROI固定
- 局所特徴点での自動registration
- 撮影条件（露出・照度）の品質判定
