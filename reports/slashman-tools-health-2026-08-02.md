# 📊 Slashman Tools 營運健康度報告
**生成時間**: 2026-08-02 20:56 UTC
**執行者**: Hermes Cron Job (自動營運檢查)

---

## 營運健康度總覽

| 領域 | 狀態 | 關鍵指標 |
|------|------|----------|
| **Cowork 框架** | ✅ 健康 | 6 agents, 286 roster, 716 已完成, 0 pending/in-progress, 3 failed |
| **Mautic** | 🟡 運行中但漏斗死亡 | Docker 4 container healthy, /subscribe 端點 404, Blog LEAD_ENDPOINT 私網 IP |
| **Gumroad 產品** | 🔴 零銷售 | 10 產品, 8 已發布+2 未發布, 全部 sales=0, 營收 $0.00 |
| **Twitter 自動化** | 🟡 DRY RUN 模式 | auto_publisher.py 每天 3 次執行但全部 [DRY RUN], 從未實際發布 |
| **YouTube 上傳** | 🟡 排隊中 OAuth 錯誤 | queue_upload.py 每 12 分鐘執行, invalid_scope token 錯誤 |
| **效能追蹤** | ✅ 正常運行 | 每 2hr 同步, 日報/週報正常生成 |
| **Blog (Hugo)** | 🟡 待修復 | 首頁空 title/og, 全站 102 頁零 Gumroad 產品連結 |
| **GitHub 開發** | ✅ 活躍 | 100 public repos, 近 48hr 10 repos 有 push |

---

## 已分派的任務

| Task ID | 優先級 | 標題 | Brain |
|---------|--------|------|-------|
| `7b064e2b` | urgent | Mautic email 漏斗診斷與修復方案 | local-ha-deepseek-v4-pro |
| `5d8810ff` | high | 修復 Twitter 自動發布器 DRY RUN 狀態 | local-ha-deepseek-v4-pro |
| `3e831153` | high | 修復 Blog 首頁空 title 及導購鏈路 | local-ha-deepseek-v4-pro |

## 歷史任務 (2026-08-01 orchestrator)

| Task ID | 標題 | 狀態 |
|---------|------|------|
| `86b2bbc7` | Gumroad 定價修復 runbook | ✅ done (需 Wayne 手動後台操作) |
| `f66ae693` | ETF 儀表板 storefront 恢復上架 | 待確認 |
| `dde57822` | 8 產品 tags 補齊至 20 | 待確認 |

---

## 關鍵問題

1. **零銷售** — 流量/漏斗問題, 非產品問題
2. **Email 漏斗死亡** — Blog 訂閱表單完全失效
3. **Twitter 自動發布器 DRY RUN** — 從未實際發布推文
4. **YouTube OAuth token 失效** — 上傳無法驗證
5. **2 款產品未發布** — AI Developer Stack ($199), AI Starter ($149)
6. **Blog SEO 問題** — 空 title/og 標籤, 零產品導購連結

## 手動操作建議 (約 10 分鐘)
1. 登入 Gumroad 後台, 修復 4 個定價為 $0 的產品 (bppdqp, diwoc, njserv, xfhfps)
2. 發布 2 款未發布產品 (nulyms, lapcqb)
3. 重新授權 YouTube OAuth token

---
*報告保存至: /home/wayne/workspace/github/slashman413/cowork/reports/slashman-tools-health-2026-08-02.md*