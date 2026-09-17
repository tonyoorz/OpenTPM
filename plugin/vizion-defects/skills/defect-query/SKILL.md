---
name: defect-query
description: 查询 BMW 缺陷数据库(octane_defects 等)的标准做法和工作原则
---

# 缺陷数据库查询技能

你接入的是 BMW 企业缺陷数据库(SQLite,本地只读)。工作方式类似 pi 这类 coding agent:用少量通用工具自主探索数据,而不是凭记忆作答。

## 可用工具

- **list_tables** — 列出所有表名。探索结构的第一步。
- **describe_table** — 返回某张表的列定义(列名/类型/是否可空/主键)。查数据前先了解结构。
- **query_defects** — 执行只读 SQL(SELECT/WITH/EXPLAIN/只读 PRAGMA),返回行数据。写操作被拒绝。
- **export_csv** — 把已查到的结构化数据导出为 CSV 文件,返回下载链接。用于大结果集场景。

## 数据库结构

主表 **octane_defects**(10万+条 BMW 缺陷数据),关键字段:

- `defect_id` — 缺陷 ID
- `name` — 缺陷名称
- `description` — 缺陷描述
- `severity` — 严重程度
- `status_phase` — 状态阶段
- `team` — 责任团队
- `program` — 项目
- `product_areas` — 产品领域(IDCEVO 等项目代号通常在这里,不一定在 team 字段)
- `owner` — 负责人
- `detected_by` — 发现者
- `creation_time` — 创建时间
- `lead_model` — 主导车型
- `phase` — 阶段
- `user_tags` — 用户标签

其他表:`octane_defect_history_events`、`octane_testcases`、`octane_manual_runs`、`octane_payloads`、`qgate_kpi_issue_transitions`、`qgate_kpi_ticket_scope` 等。不确定时先 `list_tables` 再 `describe_table`。

## 查询标准做法

1. **先探结构**:不确定表或字段时,先 `list_tables` / `describe_table`,不要凭记忆假设字段名。
2. **再探量**:`SELECT COUNT(*) FROM octane_defects` 了解规模。
3. **按维度聚合**:`SELECT team, COUNT(*) c FROM octane_defects GROUP BY team ORDER BY c DESC LIMIT 20`
4. **查明细**:`SELECT defect_id, name, severity, team FROM octane_defects WHERE product_areas LIKE '%IDCEVO%' ORDER BY creation_time DESC LIMIT 10`
5. **大表务必带 LIMIT**,避免拖垮。LIKE 模糊匹配用 `%keyword%`。

## 工作原则

1. **任何关于缺陷数据/统计/查询的问题,必须先用工具取真实数据**,再基于结果作答。回答里出现的任何具体数字或记录,必须来自工具返回,严禁凭记忆编造。
2. 不确定表结构或字段分布时,先用 `describe_table` 或 `COUNT` 探一探再查。
3. 用 Markdown 作答,注明数据来源(表名)和记录数。查询命令可在回答里简述。
4. 与缺陷数据无关的闲聊(你好、谢谢、你是谁)可直接答,不必调工具。
5. **大结果集(>30 行)必须导出文件**:先用 `query_defects` 查到数据,再调 `export_csv` 落盘成 CSV,对话里只给摘要(总数、分布、关键发现)+ 下载链接,不要把全部行数据贴进回复。单条回复被截断时数据就不完整了,文件才是完整数据的载体。
6. 多 Sheet 看板场景:每次查一个维度导出一个 CSV(如 defects-high.csv、testcases.csv、defect-testcase-link.csv),最后在对话里汇总所有链接。
