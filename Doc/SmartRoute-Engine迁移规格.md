# SmartRoute-Engine：Outreach 地址地图与投递调度迁移规格

> 文档目的：把现有 nzmarie.com 管理后台 Outreach 的 Pending / Unsent 地址地图、卡片/列表视图、发送状态与派送规划能力，迁移到独立项目 **SmartRoute-Engine**。
>
> 依据：当前仓库前端、API、数据库迁移/建表代码与北岸区域常量。本文描述的是可复核的实现和迁移规格，不是已完成的独立项目代码。

## 当前第一阶段范围（实时只读地图原型）

SmartRoute-Engine 的第一阶段先直接只读 `nzmarie`，用于复现 `/admin → Outreach → Suburb → Map` 的地址地图流程；这是验证现有业务规则的过渡方案，不替代本规格第 8 节的受控 ETL 和 SmartRoute 自有数据库目标。

- 使用 SmartRoute 独立的 Google OAuth 配置和管理员邮箱白名单；不复用原系统的 OAuth/session 密钥。
- 首期只实现北岸 Suburb 选择、报告季度选择及 Google Map 上的地址状态点；Cards、List、发送状态修改、街道规划和混合路线不在此阶段。
- 源库事务以只读方式执行；地图 API 仅返回地址坐标和派送状态，不返回地址文本或 CRM 其他字段，也不写源库。
- 业务状态仍按本规格统一计算，颜色固定为红色 Unsent、紫色 Sent、黄色 Junk；数据中不存在某种状态时如实显示零，不为满足截图而伪造点位。

## 1. 项目目标与边界

SmartRoute-Engine 是基于已有真实直邮地址、地理坐标和发送历史的派送规划系统。首期应支持：

1. 导入现有房产/地址、发送状态、按季度状态、发送事件、街道坐标与街道顺序。
2. 以北岸 Suburb、报告季度、Pending/Unsent 为主要筛选维度；Cards、List、Map 查看同一组业务数据。
3. 显示地址级的未发送、已发送、勿投三类状态；从地图或列表更新状态并保留操作历史。
4. 按街道把地址拆成可执行批次，支持自动排序、指定起始街道、手动排序及进度推进。
5. 在新的路线模型中，把“从家/基地开车到停车点—步行投递一个街区—再开车到下一停车点”建模为多段路线。

**当前能力与新项目规划必须区分：**原系统已有的是地址/街道地图、最近邻街道排序、按地址数拆批、发送状态更新、浏览器当前位置和最近未发送地址提示。原系统没有记录家庭出发点、合法停车点、道路/人行网络、驾驶与步行的多模态路线，也没有据此计算真实最短/最快路线。SmartRoute-Engine 的停车与混合交通能力属于新增功能，不能仅靠复制当前 Map 组件实现。

## 2. 当前系统实现概要

### 2.1 主页面与视图模式

页面入口为 `app/admin/outreach/page.tsx`，状态、筛选、数据请求与视图切换集中在 `app/admin/outreach/OutreachPageClient.tsx`。

| 功能 | 当前行为 | 迁移要点 |
|---|---|---|
| Pending / Unsent | Pending 标签下的 `sent_status=unsent`；可再选 Suburb、报告季度和街道 | 作为新系统默认派送工作集；Unsents 不是独立状态字段，需由季度/发送历史规则计算 |
| Cards | 属性卡片呈现地址/房产信息，支持现有后台选择、分页/滚动及相关操作 | 卡片必须消费统一的地址查询/API，不要另外维护一套状态 |
| List | 一行一条地址的列表形式，沿用相同筛选、分页和状态变更 | 支持按地址、街道、发送时间排序；列表与地图共享选择状态 |
| Map | Pending 标签才显示；在地图上绘制街道锚点和地址点，支持街道/运行批次聚焦、状态过滤、全屏、定位 | 使用惰性加载地图；保留地图加载失败重试与 API key 缺失提示 |
| Today's Route | Pending + Unsent 时显示街道队列、每街道待投数量、开始街道选择、无坐标街道提示 | 新项目应升级为 route plan 与 route stops，而不只显示纯街道序列 |
| 状态过滤 | Map 提供 All / Unsent / Sent / Junk；地址状态变更支持乐观更新 | 服务端仍需验证、持久化、审计和重新取数 |
| 发送历史 | 每地址可查询历史发送记录及报告/活动相关元数据 | 迁移 `outreach_send_logs`，不能只把地址最终状态标为 Sent |

视图状态由 `viewMode: card | list | map` 控制；Pending、Sent、Liked 是业务标签，不等同于地址状态。地图的数据请求包括 `suburb`、`report_quarter`、`sent_status`、`budget` 及 `address_coords`，地图只按当前区域和筛选返回数据。

### 2.2 地图视觉状态（三色）

地址状态和地图地址点颜色来自 `lib/outreach-map.ts`：

| 地址状态 | 语义 | 当前颜色 | Hex |
|---|---|---|---|
| `unsent` | 当前范围尚未发送 | 红色 | `#dc2626` |
| `sent` | 当前范围已有发送记录 | 紫色 | `#7c3aed` |
| `junk` | 勿投 / no-junk-mail | 黄色 | `#eab308` |

状态优先级是 `junk > sent > unsent`：地址标记为勿投时地图显示 Junk，即使历史上曾发送过。报告街道标签另有颜色（有未发送红色、全已发送蓝色、无待投灰色），不要把街道标签颜色与地址三色状态混淆。运行批次锚点还会按 Run 使用紫、青、橙、玫红、灰等颜色；这些是路线分组装饰色，不是地址状态。

### 2.3 地图交互

- 街道锚点显示该街待投地址数；选中街道时地图聚焦该街地址坐标。
- 地址点在较高缩放级别出现；未发送点较醒目。信息窗显示地址/状态、Google Maps 外链、Junk/Unjunk、Sent 和整街发送等操作（依当前回调配置显示）。
- 地图支持全量/运行批次范围缩放、地址状态筛选、街道侧栏折叠/展开和运行批次选择。
- 浏览器定位通过 Geolocation API 获取用户设备当前位置，在页面会话内计算最近的未发送地址并显示直线距离；这不是保存家庭地址，也不是道路导航或停车位查询。
- 对发送、Junk、Unjunk 状态更新使用乐观 UI；请求失败时回滚并记录错误。迁移时保留回滚与服务端错误反馈语义。
- 地图使用 Google Maps JS API（`@vis.gl/react-google-maps`）并由 `DynamicMapView` 动态加载，SSR 关闭。

### 2.4 当前街道排序与运行批次算法

实现主要位于 `lib/street-ordering.ts`、`lib/street-clustering.ts`、`lib/street-cluster-reorder.ts` 和 `app/api/admin/outreach/street-clusters/route.ts`。

1. 对地址按 `(suburb, street, address/property id)` 去重并生成街道摘要。
2. 每街选取最小门牌号地址的坐标作为街道锚点；当前排序依据该锚点，而不是街道平均点，也不是逐门牌逐户的完整步行路径。
3. 若用户未指定起点，选择所有可定位街道中最小门牌号对应街道作为起始街道（门牌相同时按街名排序）；如指定起始街道，则从该街开始。
4. 使用 Haversine 球面距离进行贪心最近邻：每一步选距离当前街道锚点最近的剩余街道。没有坐标的街道追加在末尾并按街名排序。
5. 按待投地址数分成运行批次。当前 API 的 Unsent 批次预算默认 30；地图直接请求常用预算 20。算法是按顺序累计地址数并在接近预算时拆分，不是容量、工时或道路成本最优化。
6. 手动街道顺序保存于 `admin_settings`，键为 `outreach_street_order:<suburb>`；用户选起点时会重排并重新拆批。
7. 街道聚类库还提供以 seed 为中心半径聚类、预算拆批等工具；当前主要街道列表路由实际采用有序街道拆批流程。`radius` 参数仍保留兼容性，不应误解为道路可达距离或路由引擎。

因此新项目的算法应将现有贪心结果当作可解释的 baseline，不应对外描述为全局最优路线。

## 3. 北岸区域范围

当前仓库 `lib/geo-data.ts` 将 42 个 Suburb 列入 `North Shore City`；截图中的 Quick Filter 展示其中 39 个。下表先严格按截图从左到右、从上到下列出顺序，截图未显示的 3 个源常量区域另列于表后。区域常量不代表每个区域都有有效坐标或现存直邮记录；实际迁移行数必须以源数据库查询为准。

| 截图行 | Suburb（按从左到右顺序） |
|---:|---|
| 1 | Northcross → Oteha → Torbay → Fairview Heights → Waiake → Browns Bay → Long Bay → Pinehill → Rothesay Bay |
| 2 | Murrays Bay → Albany → Rosedale → Mairangi Bay → Campbells Bay → Sunnynook → Unsworth Heights → Schnapper Rock |
| 3 | Greenhithe → Totara Vale → Castor Bay → Forrest Hill → Bayview → Wairau Valley → Glenfield → Milford → Hillcrest |
| 4 | Birkdale → Beach Haven → Takapuna → Northcote → Birkenhead → Hauraki → Chatswood → Northcote Point → Belmont |
| 5 | Bayswater → Narrow Neck → Devonport → Stanley Point |

**截图未显示、但仍在 `lib/geo-data.ts` 北岸常量中的区域：**Okura、Paremoremo、Windsor Park。迁移应保留这 3 个源区域；若 SmartRoute 的区域选择器要与截图完全一致，则将它们作为额外/未列入 Quick Filter 的区域处理，不要插入或打乱上述 39 个截图顺序。

系统实际地址/发送数据是受保护的业务数据。仓库代码没有提供可信的实时总数，本次也不读取生产数据库，因此本文不填写地址数、发送数或坐标完整率等虚构数字。新项目上线前需从授权源库统计并记录迁移批次、导入行数、去重数、缺坐标数及状态校验结果。

## 4. 现有前后端代码与数据源索引

### 4.1 前端

| 路径 | 职责 |
|---|---|
| `app/admin/outreach/OutreachPageClient.tsx` | Cards/List/Map 切换，Pending/Unsent 状态、筛选、分页、Today's Route 数据及地图事件连接 |
| `app/admin/outreach/components/DynamicMapView.tsx` | 地图动态导入、地图 chunk 错误边界及重试 |
| `app/admin/outreach/components/OutreachMapView.tsx` | Google 地图、坐标加载、地址/街道标记、信息窗、缩放、当前位置、最近未发送地址及地图端状态操作 |
| `app/admin/outreach/components/TodayRunSection.tsx` | Unsent 街道顺序、开始街道、每街计数、无坐标提示 |
| `app/admin/outreach/components/OutreachMapSidebar.tsx` | 状态统计、街道/运行列表、展开/折叠与过滤 |
| `app/admin/outreach/components/OutreachMapToolbar.tsx` | Fit All 和运行批次快速聚焦 |
| `app/admin/outreach/components/OutreachMapMarker.tsx`、`OutreachStreetLabel.tsx`、`OutreachMapInfoWindow.tsx` | 地图 UI 辅助组件 |
| `app/admin/outreach/components/ManualRunPanel.tsx` | 街道手动排序 |
| `app/admin/outreach/components/DispatchHistoryDrawer.tsx` | 地址发送历史面板 |
| `lib/outreach-map.ts` | 地址颜色、街道标签状态、距离与地图 DOM 辅助方法 |
| `lib/outreach-streets.ts` | 地址去重、街道摘要、地址状态合并及锚点数据 |
| `lib/outreach-pagination.ts` | Cards/List/Unsents 的分页大小辅助 |

### 4.2 服务端/API

下列 API 当前由后台登录/管理员权限保护。独立项目需要重建认证、授权、参数校验、限流与审计，不应将旧管理 API 暴露给公众。

| 路径 | 职责 |
|---|---|
| `app/api/admin/outreach/route.ts` | Outreach 卡片/列表查询及筛选、排序/分页数据 |
| `app/api/admin/outreach/street-clusters/route.ts` | 按地址/坐标计算街道顺序、地址级状态、批次及坐标数据；使用 Redis 缓存 |
| `app/api/admin/outreach/street-order/route.ts` | 读取/保存/清除街道手动顺序 |
| `app/api/admin/outreach/nearby-streets/route.ts` | 给定街道中心点，返回半径范围内街道（辅助/调试接口） |
| `app/api/admin/outreach/[id]/route.ts` | 地址字段/PATCH 状态操作，包括勿投状态 |
| `app/api/admin/outreach/[id]/mark-sent/route.ts`、`[id]/status/route.ts` | 标记已发送、更新 Pending/Sent/按季度状态 |
| `app/api/admin/outreach/[id]/history/route.ts` | 按地址读取发送历史 |
| `app/api/admin/outreach/send/route.ts` | 批量记发送日志，更新地址汇总状态和按季度状态，失效缓存 |
| `app/api/admin/outreach/streets/geocode/route.ts`、`streets/prewarm/route.ts` | 街道坐标补齐/预热 |
| `app/api/admin/outreach/suburb-sent-stats/route.ts`、`campaign-stats/route.ts` | 区域/活动发送统计 |
| `lib/outreach-filter.ts` | `pending`、`sent_status`、季度、发送日志和 no-junk-mail 的服务端过滤规则 |
| `lib/db.ts` | Outreach 表的运行时建表/兼容处理，包含地址、发送日志和 QR 表的建表 SQL |
| `lib/redis.ts` | 街道聚类缓存键、读写和失效 |

关联数据库迁移还包括：`database/migrations/012_create_outreach_tables.sql`、`001_create_outreach_properties.sql`、`033_create_outreach_materialized_view.sql`、`039_create_street_locations.sql`、`040_add_outreach_house_number.sql`、`041_backfill_outreach_house_number.sql`、`038_create_admin_settings.sql` 和 `migrations/001_quarter_aware_outreach_status.sql`。数据库中可能同时有旧 `outreach_tasks` 和当前 `outreach_properties` 两种设计；新项目迁移应以实际使用的 `outreach_properties`/发送日志为主，核验后再决定是否合并旧队列表。

## 5. 源数据库结构与字段含义

当前代码/迁移中与地图迁移相关的主要表：

### 5.1 `outreach_properties`：地址/房产工作记录

基础字段来自 `001_create_outreach_properties.sql`、`012_create_outreach_tables.sql` 和 `lib/db.ts`，实际数据库另有后续迁移增加的字段。迁移前应检查生产 `information_schema`，以下字段是地图及发送逻辑依赖的核心交集：

| 字段 | 用途 |
|---|---|
| `id UUID` | Outreach 地址记录 ID；建议新系统保留原 ID 作为 `source_outreach_id` |
| `property_id UUID` / `louis_property_id` | 关联属性记录。当前地图优先以去除连字符后的 `property_id` 连接 `properties.id` |
| `property_address TEXT` | 地址显示与 fallback 关联字段；属于个人/业务敏感数据 |
| `suburb`, `city`, `region`, `street`, `house_number` | 区域、街道、门牌号及街道排序 |
| `campaign`, `status` | 活动与整体状态；历史基础状态使用 pending/sent/interacted/converted，勿投并非该字段的合法替代 |
| `sent_at`, `sent_by`, `last_sent_at`, `last_campaign`, `total_send_count` | 发送概况/兼容旧发送状态逻辑 |
| `selected_by`, `selected_at`, `notes`, `created_at`, `updated_at` | 操作人、备注和审计/排序相关元数据 |

`outreach_properties.status` 是跨活动汇总状态；季度筛选不能简单依靠它判断 Sent/Unsent。

### 5.2 发送与按季度状态

`outreach_send_logs` 在 `lib/db.ts` 中创建：`id`、`outreach_property_id`、`suburb_report_id`、`report_title`、`campaign_key`、`suburb`、`sent_at`、`sent_by`、`notes`、`created_at`。每次发送应保留一笔日志，不能只更新地址状态。

`outreach_property_quarter_status` 在 `migrations/001_quarter_aware_outreach_status.sql` 中定义：地址/报告组合唯一；包含 `suburb`、`quarter`、`year`、生成的 `quarter_key`、`status(pending|sent|partial)`、`sent_count`、首末发送时间和 `campaign_keys`。`database/migrations/057_add_quarter_dispatch_junk.sql` 另加 `is_junk`、`junk_at`。Junk 可能按全局属性或报告季度维护，迁移时必须保留来源层级，不能把季度勿投误写成全局勿投。

### 5.3 坐标与街道地点

- 地图 API 从 `properties.latitude/longitude` 取地址坐标，优先关联 `outreach_properties.property_id` 与 `properties.id`；另有按地址+Suburb 的 fallback。
- 同一属性源上的 `properties.no_junk_mail` 用于 Junk 状态。经纬度缺失地址仍应保留在列表并计入“缺坐标”诊断，但不能错误地当成已完成。
- `street_locations`（`database/migrations/039_create_street_locations.sql`）唯一键为 `(suburb, street)`，保存 `center_lat/lng`、`source`、`property_count`、`geocoded_at`。初始点可由该街所有有效房产坐标平均得到，属于街道代表点，不是实际停车点。
- 若迁移服务将属性库与 Outreach 库拆分，先导出/传输匹配后的最小必要字段，不要让 SmartRoute 依赖原系统运行时跨库 JOIN。

### 5.4 参考 SQL：源库结构（简化）

以下是依据仓库迁移/运行时 DDL 汇总的核心结构示意，非完整生产 schema，也不是可直接执行的生产迁移：

```sql
CREATE TABLE outreach_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID,
  louis_property_id VARCHAR(100),
  property_address TEXT NOT NULL,
  suburb VARCHAR(100) NOT NULL,
  city VARCHAR(100) NOT NULL,
  region VARCHAR(100) NOT NULL,
  street VARCHAR(200),
  house_number BIGINT,
  campaign VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMP,
  sent_by VARCHAR(255),
  selected_by VARCHAR(255),
  selected_at TIMESTAMPTZ,
  last_campaign VARCHAR(100),
  total_send_count INT DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (property_address, campaign)
);

CREATE TABLE outreach_send_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outreach_property_id UUID NOT NULL
    REFERENCES outreach_properties(id) ON DELETE CASCADE,
  suburb_report_id UUID,
  report_title VARCHAR(255) NOT NULL,
  campaign_key VARCHAR(100) NOT NULL,
  suburb VARCHAR(100) NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_by VARCHAR(255) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE street_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suburb VARCHAR(100) NOT NULL,
  street VARCHAR(200) NOT NULL,
  center_lat DOUBLE PRECISION,
  center_lng DOUBLE PRECISION,
  source VARCHAR(20) NOT NULL DEFAULT 'properties',
  property_count INT DEFAULT 0,
  geocoded_at TIMESTAMP,
  UNIQUE (suburb, street)
);
```

完整按季度状态以版本迁移 `migrations/001_quarter_aware_outreach_status.sql` 为准；以上 SQL 只帮助新项目理解字段，不替代源库 DDL 核验。

## 6. SmartRoute-Engine 建议数据模型

建议将迁移后的表放入 SmartRoute 自有数据库，保留来源 ID 和导入批次，避免新系统写入旧系统。下方为 PostgreSQL/CockroachDB 风格的首版逻辑 DDL 草案。实际执行前按所选托管数据库核对 UUID 默认值、生成列、部分索引和事务支持。

### 6.1 核心表

```sql
CREATE TABLE sr_suburbs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL UNIQUE,
  city VARCHAR(100) NOT NULL DEFAULT 'North Shore City',
  region VARCHAR(100) NOT NULL DEFAULT 'Auckland',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  source_name VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sr_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_property_id UUID,
  suburb_id UUID NOT NULL REFERENCES sr_suburbs(id),
  property_address TEXT NOT NULL,
  street VARCHAR(200),
  house_number BIGINT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  coordinate_source VARCHAR(40),
  coordinate_quality VARCHAR(20) NOT NULL DEFAULT 'unknown'
    CHECK (coordinate_quality IN ('unknown','property','geocoded','verified')),
  is_junk BOOLEAN NOT NULL DEFAULT FALSE,
  junk_at TIMESTAMPTZ,
  source_created_at TIMESTAMPTZ,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (suburb_id, property_address)
);
CREATE INDEX sr_addresses_suburb_street_house
  ON sr_addresses (suburb_id, street, house_number);
CREATE INDEX sr_addresses_geo
  ON sr_addresses (suburb_id, latitude, longitude);
CREATE INDEX sr_addresses_status
  ON sr_addresses (suburb_id, base_status, is_junk);

CREATE TABLE sr_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_campaign_key VARCHAR(100) NOT NULL,
  suburb_id UUID NOT NULL REFERENCES sr_suburbs(id),
  name VARCHAR(255) NOT NULL,
  report_title VARCHAR(255),
  quarter VARCHAR(2),
  year INT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_campaign_key, suburb_id)
);

CREATE TABLE sr_address_campaign_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_outreach_id UUID NOT NULL UNIQUE,
  address_id UUID NOT NULL REFERENCES sr_addresses(id),
  campaign_id UUID NOT NULL REFERENCES sr_campaigns(id),
  suburb_id UUID NOT NULL REFERENCES sr_suburbs(id),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sent','partial')),
  is_junk BOOLEAN NOT NULL DEFAULT FALSE,
  sent_count INT NOT NULL DEFAULT 0,
  first_sent_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  source_quarter_status_id UUID UNIQUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (address_id, campaign_id)
);
CREATE INDEX sr_campaign_status_filter
  ON sr_address_campaign_status (suburb_id, campaign_id, status, is_junk);

CREATE TABLE sr_send_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_send_log_id UUID UNIQUE,
  address_campaign_status_id UUID NOT NULL
    REFERENCES sr_address_campaign_status(id),
  address_id UUID NOT NULL REFERENCES sr_addresses(id),
  campaign_id UUID REFERENCES sr_campaigns(id),
  source_campaign_key VARCHAR(100),
  sent_at TIMESTAMPTZ NOT NULL,
  sent_by VARCHAR(255),
  notes TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sr_send_events_address_date
  ON sr_send_events (address_id, sent_at DESC);
CREATE INDEX sr_send_events_campaign_date
  ON sr_send_events (campaign_id, sent_at DESC);

CREATE TABLE sr_street_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suburb_id UUID NOT NULL REFERENCES sr_suburbs(id),
  street VARCHAR(200) NOT NULL,
  center_lat DOUBLE PRECISION,
  center_lng DOUBLE PRECISION,
  source VARCHAR(30) NOT NULL DEFAULT 'property_average',
  property_count INT NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (suburb_id, street)
);
```

### 6.2 调度与操作审计表

```sql
CREATE TABLE sr_route_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suburb_id UUID NOT NULL REFERENCES sr_suburbs(id),
  campaign_id UUID REFERENCES sr_campaigns(id),
  plan_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ready','in_progress','completed','cancelled')),
  start_lat DOUBLE PRECISION,
  start_lng DOUBLE PRECISION,
  start_label VARCHAR(255),
  travel_mode VARCHAR(20) NOT NULL DEFAULT 'mixed'
    CHECK (travel_mode IN ('walk','drive','mixed')),
  address_budget INT NOT NULL DEFAULT 30,
  algorithm_version VARCHAR(40) NOT NULL,
  objective_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  estimated_distance_m INT,
  estimated_duration_s INT,
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sr_route_plans_date
  ON sr_route_plans (plan_date DESC, suburb_id, status);

CREATE TABLE sr_route_stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_plan_id UUID NOT NULL REFERENCES sr_route_plans(id) ON DELETE CASCADE,
  sequence_no INT NOT NULL,
  stop_type VARCHAR(20) NOT NULL
    CHECK (stop_type IN ('start','parking','street','finish')),
  travel_mode_from_previous VARCHAR(20)
    CHECK (travel_mode_from_previous IN ('walk','drive')),
  suburb_id UUID NOT NULL REFERENCES sr_suburbs(id),
  street VARCHAR(200),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  parking_source VARCHAR(30),
  parking_reference VARCHAR(255),
  estimated_distance_m INT,
  estimated_duration_s INT,
  instructions TEXT,
  UNIQUE (route_plan_id, sequence_no)
);

CREATE TABLE sr_route_stop_addresses (
  route_stop_id UUID NOT NULL REFERENCES sr_route_stops(id) ON DELETE CASCADE,
  address_campaign_status_id UUID NOT NULL
    REFERENCES sr_address_campaign_status(id),
  address_id UUID NOT NULL REFERENCES sr_addresses(id),
  sequence_no INT NOT NULL,
  status_at_plan_time VARCHAR(20) NOT NULL,
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY (route_stop_id, address_campaign_status_id),
  UNIQUE (route_stop_id, sequence_no)
);

CREATE TABLE sr_dispatch_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id UUID NOT NULL REFERENCES sr_addresses(id),
  route_plan_id UUID REFERENCES sr_route_plans(id),
  event_type VARCHAR(30) NOT NULL
    CHECK (event_type IN ('marked_sent','marked_pending','marked_junk','unjunked','route_skipped')),
  previous_value JSONB,
  new_value JSONB,
  actor VARCHAR(255),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id VARCHAR(100)
);
CREATE INDEX sr_dispatch_events_address_date
  ON sr_dispatch_events (address_id, occurred_at DESC);
```

`sr_route_stops` 建模的是停车/街道等路线节点；`sr_route_stop_addresses` 保存路线生成时的地址快照和执行顺序。停车点必须来自经许可的停车数据源、人工核验点或用户配置；当前 `street_locations` 平均坐标不能被当成合法停车点。

## 7. 混合驾驶/步行调度算法规格

### 7.1 输入、约束与输出

**输入：**指定日期/班次、出发位置（家/办公室/自定义基地，可选且需用户主动设置）、Suburb、活动/季度、未发送地址及有效坐标、停车点候选数据、地址预算、步行/驾驶速度或时间成本、单地址投递服务时间、工作时间窗、禁投/勿投状态、手动锁定街道/停靠点。

**硬约束：**

- `junk` 地址不得加入派送任务；已发送地址按当前 campaign/quarter 状态过滤。
- 不得把没有坐标的地址自动当作可路由地址；要进入“待地理编码”队列。
- 每个地址最多分配到该计划一次；已确认投递的地址不得被重复排入同一计划。
- 每个停车点需有位置、来源及可用状态。未知或未验证的停车信息只能显示为候选，不得宣称合法/可停车。
- 预算/工时超限则切成多个 Run/Shift，保留地址不丢失。
- 人工固定的起点/街道/停车点优先于自动排序，并明确提示无法满足的约束。

**输出：**带算法版本的路线计划、按序停车点/街道/地址、各段 travel mode、预计距离/时间、地址数、无坐标/未分配原因、可解释的成本分项与操作进度。

### 7.2 首版可落地步骤

1. **筛选有效地址**：按 Suburb + campaign/quarter 选择 pending/unsent，排除 Junk；发送状态采用季度状态表与发送日志，而不是仅看总 `outreach_properties.status`。
2. **地址级校验**：按坐标、Suburb 和标准化街道分组。去重键优先使用稳定的源地址 ID，辅助检查标准化地址重复项。
3. **街区/投递序列**：保留原 greedy nearest-neighbour 作 baseline；从用户选定起点出发，候选下一街按道路/步行网络路由成本排序，先形成连续且可步行的街区段。
4. **选择停车候选**：对下一步所需街区，收集已验证停车点。估计“当前停车点驾车到候选停车点 + 停车到街道首户步行 + 街道内步行 + 预计投递服务时间”。选择满足规则且总代价最低者；没有合法停车数据时输出人工确认，不虚构停车位置。
5. **混合路段**：停车点之间为 drive leg，停车点到投递街区以及街区内为 walk leg；结束一个步行簇后可返回原停车点，也可在另一端预先批准的停车点结束，再进入下一驾驶段。
6. **成本函数**：`C = w_drive*T_drive + w_walk*T_walk + w_service*T_service + w_repark*T_repark + w_risk*uncertainty`。默认采用可解释权重；保留路线候选、距离矩阵/交通服务版本和时间戳，以支持重算与审计。
7. **切分批次**：按地址预算和工作时间窗拆分。原系统预算可用 30 作为兼容默认值，但应在新项目按真实工作负载配置；不能因切分让单街剩余地址消失。
8. **执行与重排**：每投递地址记录 dispatched/sent 事件。整街完成后，从剩余未发送任务重新优化后续序列；用户可锁定当前路线段并查看重排差异。

首版没有道路网络或停车数据时，提供两种明确模式：A) 步行最近邻（与旧系统一致，仅直线距离启发）；B) 手动选择停车点 + 旧街道排序。待接入授权道路/步行路线 API 和停车数据后，才开放自动混合路线。必须在 UI 标明路线是“估算”而非导航级结果。

### 7.3 质量指标

- 地址迁移 ID/记录数/去重差异与发送日志总数逐批核对。
- 地址坐标完整率、无效经纬度数、街道无锚点数，按 Suburb 和导入批次统计。
- 各 campaign/quarter 的 pending/sent/partial/Junk 数和发送事件数与源库核对。
- 路线计划要求地址无遗漏/无重复、Junk 不入路线、人工锁定点保持、路线距离/时间有单位和来源。
- 记录相对于旧排序的比较（总估算路程、步行/驾驶时间、地址覆盖率），禁止以单一运行样例推断全区域收益。

## 8. 数据迁移步骤

### 8.1 来源与范围

来源为授权 Outreach 数据库中的 `outreach_properties`、`outreach_send_logs`、`outreach_property_quarter_status`、`street_locations`、`admin_settings`，以及提供坐标/no-junk-mail 的 `properties` 数据。campaign/report 元数据来自 `suburb_reports`。仅迁移 SmartRoute 的派送所需字段；与投递无关的房产估值、所有人姓名、QR 扫描 IP/User-Agent 等不属于地图迁移必要数据，不应默认复制。

### 8.2 ETL 过程

1. 盘点源端表、列、数据类型、约束和索引；以实际生产 schema 为准，因源仓库存在迁移累计和旧/新表并存。
2. 固定导出快照及 `migration_batch_id`；在安全传输通道中导出地址、ID、Suburb、街道、门牌、坐标、勿投、campaign/quarter 状态和全部发送事件。
3. 先导入 `sr_suburbs`（使用本文件 42 区清单，但只对真实源数据启用有效区域），再导入 campaigns、addresses、quarter status、send events、street locations。
4. 保留源 ID 到 SmartRoute ID 的稳定映射；地址以原 `outreach_properties.id` 写入 `source_outreach_id`，发送日志以原 `outreach_send_logs.id` 写入 `source_send_log_id`。
5. 坐标 JOIN 按源逻辑优先使用 property ID；仅在 ID 不可匹配时才使用规范化地址+Suburb fallback，并记录匹配方式/置信度。
6. 逐批核对总数、重复地址、发送次数、季度状态、Junk 数、坐标合法性与无匹配记录。异常先进入隔离表/报告，不静默丢弃。
7. 开始只读影子运行；比较 Cards/List/Map 筛选结果及每个 Suburb/quarter 的状态统计；审批后切换新项目读写。

源数据可能包含住址等敏感信息。不要将原始 CSV、生产地址、真实用户坐标、数据库连接串或未经脱敏的查询结果提交 Git，也不要将数据复制到本说明文档。生产迁移应有最小权限、传输加密、备份、日志脱敏和删除/回滚计划。

### 8.3 迁移核对 SQL 样例

以下查询在受控源库执行，输出只用于核对，不应提交包含明细地址的结果：

```sql
-- 按 Suburb 统计 Outreach 地址数和有效坐标数
SELECT op.suburb,
       COUNT(DISTINCT op.id) AS address_count,
       COUNT(DISTINCT op.id) FILTER (
         WHERE COALESCE(p.latitude, p_addr.latitude) IS NOT NULL
           AND COALESCE(p.longitude, p_addr.longitude) IS NOT NULL
       ) AS geocoded_count
FROM outreach_properties op
LEFT JOIN properties p
  ON REPLACE(op.property_id::text, '-', '') = p.id
LEFT JOIN properties p_addr
  ON p.id IS NULL
 AND p_addr.address = op.property_address
 AND p_addr.suburb = op.suburb
WHERE op.street IS NOT NULL AND TRIM(op.street) <> ''
GROUP BY op.suburb
ORDER BY op.suburb;

-- 发送事件和按季度状态计数
SELECT suburb, COUNT(*) AS send_event_count
FROM outreach_send_logs
GROUP BY suburb
ORDER BY suburb;

SELECT suburb, quarter_key, status, COUNT(*) AS address_count,
       SUM(sent_count) AS send_count
FROM outreach_property_quarter_status
GROUP BY suburb, quarter_key, status
ORDER BY suburb, quarter_key, status;
```

如果源库位于独立数据库/集群，应先在源端计算并导出必要字段；不要假设可以直接在新库跨库 JOIN。

## 9. SmartRoute API 与工程拆分建议

建议 API（路径仅为新项目设计建议）：

| Endpoint | 职责 |
|---|---|
| `GET /api/v1/addresses` | Cards/List 统一搜索、状态/活动/季度/Suburb 筛选及分页 |
| `GET /api/v1/map/addresses` | 地图视口/区域地址点及聚合街道摘要，限制返回量 |
| `GET /api/v1/routes/preview` | 纯预览路线，不写入发送状态；返回算法版本和成本分项 |
| `POST /api/v1/routes` | 创建并冻结路线计划快照 |
| `PATCH /api/v1/routes/{id}/stops/{stopId}` | 人工重排/锁定停靠点并重算 |
| `POST /api/v1/dispatch-events` | 标记 Sent、Pending、Junk/Unjunk 并追加审计记录 |
| `GET /api/v1/addresses/{id}/send-history` | 地址完整发送历史 |
| `GET /api/v1/regions/north-shore/suburbs` | 返回启用的北岸 Suburb 和地址/待投统计 |

建议模块：`web/cards-list`、`web/map`、`web/route-planner`；`api/addresses`、`api/routes`、`api/dispatch`；`domain/status`、`domain/geocoding`、`domain/route-cost`、`domain/optimizer`；`db/migrations`、`workers/geocode`。将当前状态算法做成纯函数并对规则写单元测试，地图/数据库/API 层不得各自重新解释 Sent/Unsent。

## 10. Admin 管理端与 Google 登录

SmartRoute-Engine 应提供与现有项目类似的 `/admin` 管理端：未登录访问 `/admin/*` 时转到 `/admin/login`，登录页提供 **Sign in with Google**，登录成功后进入 `/admin/dashboard`。身份认证采用 Google OAuth / OpenID Connect；认证成功不代表自动获得管理权限，必须再检查 SmartRoute 自己的管理员白名单/用户表。

### 10.1 认证与授权规则

当前仓库的实现参考位于 `lib/auth.config.ts`、`lib/auth.ts`、`app/admin/login/page.tsx`、`middleware.ts` 和 `database/schema.sql` 的 `admin_users`。其中 Google Provider、7 天 JWT session、管理员表查验和角色信息可作为功能参考；新系统应使用独立 OAuth 客户端、独立 session secret 和 SmartRoute 自己的管理员记录，不复制现有项目的密钥或生产账号数据。

建议角色：

| 角色 | 权限 |
|---|---|
| `super_admin` | 管理员与角色配置、导入/迁移、全区数据、路线规则和审计查询 |
| `admin` | 读取地址/地图、建立路线、记录投递与状态；不能管理用户、密钥或迁移配置 |
| `viewer` | 只读 Cards/List/Map/路线，不得修改发送状态或路线计划 |

安全要求：

1. **服务端是授权最终依据。** 页面 middleware 只负责登录体验/跳转，不能只通过“存在 session cookie”或前端隐藏按钮判权。每个 `/api/admin/*` handler 都验证有效 session，再从数据库确认用户 `is_active=true`、当前角色和具体 permission；未授权分别返回 401/403。
2. OAuth 登录回调中校验 Google 返回的 email 已验证（`email_verified`）、邮箱在管理员 allowlist 中、用户未禁用。不要只根据 `@gmail.com`、邮件域或用户可自行修改的请求参数授权。
3. 不开放自助注册；新增管理员由 super_admin 在受审计的管理流程中邀请/启用。角色提权、禁用和重新启用都写审计事件。
4. 使用安全、HttpOnly、SameSite=Lax、生产环境 Secure 的 session cookie；设置短而合理的 session max-age、服务端撤销/禁用检查、CSRF 防护和登录失败/异常告警。敏感操作（批量发送、导出、管理员维护）可要求近期重新认证。
5. OAuth `callbackUrl` 必须限制为站内相对路径或允许的同源 URL，拒绝外部 URL，避免 open redirect。
6. 地图地址、精准坐标和历史属于敏感业务数据；API 按角色授权，导出权限单独控制，日志不写原始地址、access token、session token 或 OAuth secret。

建议 SmartRoute 用户表：

```sql
CREATE TABLE sr_admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255),
  google_subject VARCHAR(255) UNIQUE,
  role VARCHAR(30) NOT NULL
    CHECK (role IN ('super_admin','admin','viewer')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES sr_admin_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sr_admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_admin_id UUID REFERENCES sr_admin_users(id),
  action VARCHAR(80) NOT NULL,
  target_type VARCHAR(80),
  target_id VARCHAR(255),
  outcome VARCHAR(20) NOT NULL,
  request_id VARCHAR(100),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX sr_admin_audit_actor_time
  ON sr_admin_audit_log (actor_admin_id, created_at DESC);
```

不要把 Google client secret、session secret 或密码保存在 `sr_admin_users`。`google_subject` 是 Google OIDC 稳定用户标识，首次受信登录后绑定；邮箱仍需和管理员 allowlist/账号状态核对。

### 10.2 Google OAuth 配置和 `.env` 获取

当前仓库的变量名可在 `.env.local.example` 找到：`NEXTAUTH_URL`、`NEXTAUTH_SECRET`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`DATABASE_URL`、`LOUIS_DATABASE_URL` 和 `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`。这只说明变量名称与开发配置方式，**不意味着 SmartRoute 应复用旧项目的生产值**。

SmartRoute-Engine 配置流程：

1. **建立独立 OAuth client**：由组织 Google Cloud 管理员在受控 Cloud 项目中为 SmartRoute 配置 OAuth consent screen 和 Web application OAuth client；如组织使用 Workspace，可同时设置允许的组织用户范围。将本地与生产 redirect URI 分开登记。Auth.js/NextAuth v5 常用回调形如 `https://<SmartRoute 域名>/api/auth/callback/google`；须以实际 NextAuth 版本和部署 base URL 核实，不能照抄旧域名。
2. **取得 OAuth 参数**：`GOOGLE_CLIENT_ID` 可以按公开客户端 ID 的方式配置；`GOOGLE_CLIENT_SECRET` 只从 Cloud Console 的受权限控制界面或组织 secret manager 获取。若没有权限，应向当前 OAuth 项目 owner 申请为 SmartRoute 单独创建/授权 client；不要从聊天、代码仓库、他人 shell 或 `.env` 文件中寻找/转发现有 secret。
3. **生成新的 session secret**：为 SmartRoute 独立生成高熵随机 `NEXTAUTH_SECRET`（或按所用 Auth.js 版本采用其推荐的 `AUTH_SECRET` 名称），开发/测试/生产分别管理；不可复用当前项目密钥。不要将密钥放进 Git、文档、issue、截图或前端 `NEXT_PUBLIC_*` 变量。
4. **准备独立数据库账号**：通过数据库平台受控管理界面创建 SmartRoute 的数据库/集群和专用服务账号，以 TLS 连接串配置 `DATABASE_URL`。按应用职责授予最小读写权限；schema 迁移账号与运行时账号宜分离，运行时账号不应有创建管理员/扩展等权限。不要把当前生产库的 URL 直接复制为新项目数据库。
5. **授权数据迁移**：如果 SmartRoute 需要真实发送数据，由有权限的管理员批准一次性/受控 ETL；导出最小必要字段后通过加密传输导入 SmartRoute 数据库。不要为了读取生产数据而长期给新应用账号开放旧生产库全表权限。`LOUIS_DATABASE_URL` 是当前项目双库实现中的属性源库变量，SmartRoute 首选导入必要的属性坐标/地址，不依赖该旧连接长期在线。
6. **本地配置**：复制新项目无密钥模板到本地 `.env.local`，填入本地 OAuth callback 对应 client、SmartRoute 开发数据库连接串和随机 secret。确认 `.env.local`、`.env.*` 已加入 `.gitignore`，且模板只放 `your_*` 占位符。
7. **部署配置**：在 Vercel/云平台/组织 secret manager 的 SmartRoute 环境变量设置中分别填 Preview、Staging、Production 值；限制读取/修改权限并启用审计。改动 OAuth redirect URI 后做登录与登出 smoke test；密钥轮换后撤销旧值。

模板示意（仅变量名和虚构占位符；不可把下面字符串当成真实凭据）：

```dotenv
# SmartRoute 本地地址；部署环境使用各自公开域名
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=replace-with-a-new-random-secret
GOOGLE_CLIENT_ID=your_sm_engine_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_sm_engine_client_secret

# SmartRoute 专用数据库，不要粘贴现有生产环境连接串
DATABASE_URL=postgresql://sm_engine_app:replace-me@localhost:5432/smartroute?sslmode=require

# 限制 referrer/API 权限的浏览器端 Maps key；服务端 OAuth/路由密钥不得使用 NEXT_PUBLIC_ 前缀
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_restricted_maps_key
```

变量名应与新项目选择的 NextAuth/Auth.js 版本保持一致；当前仓库示例使用 `NEXTAUTH_*`。`.env.local.example` 中还出现 `LOUIS_DATABASE_URL`、Analytics、Chatbot 和 Cloudflare R2 等其他系统变量，除非 SmartRoute 明确需要对应功能，不要为了“数据全面”而一并复制。

`.env` 不是可迁移的数据表，也不应作为项目交付文档的一部分。需要“全面数据”应通过第 8 节 ETL 对**经批准的业务数据**建立字段清单、导出快照、行数/状态核对和审计；OAuth/API 密钥只用于配置 SmartRoute 服务，绝不能导入数据库或写入文档。

## 11. 安全、隐私与可靠性要求

- 私有地址和准确坐标属于敏感业务数据；地图、API、导出均需认证与 Suburb/角色级授权。
- 不把完整地址、个人位置、数据库 ID/令牌写入可公开日志；使用加密传输、密钥管理和可审计的访问记录。
- 用户当前位置只在浏览器会话内使用，除非用户明确授权，不上传或写入 `sr_addresses`。
- 状态修改和批量派送须幂等，保留操作者、时间、前后值；客户端乐观更新失败必须回滚并清楚告警。
- 地图接口按 viewport/区域分页或聚合，避免一次返回全库坐标。缓存键应含 Suburb、季度、状态、活动等所有影响数据的维度；发送/勿投/手动排序变更后清理缓存。
- Google Maps key 仅使用受限的客户端 key；服务端道路/地理编码密钥不得暴露给浏览器。确认地图供应商的数据存储/使用条款和地理数据许可。
- 地理编码/路线外部服务失败时显式返回降级状态；不以假坐标、静默空数据或直线距离冒充真实道路导航。

## 12. 建议实施验收清单

- [ ] 确认源库 schema、数据库版本、地址主键映射和可迁移字段。
- [ ] 42 个北岸 Suburb 名称与源数据规范一致；记录不匹配名称，不自动丢弃。
- [ ] 对同一 campaign/quarter，SmartRoute 的 Pending/Sent/Partial/Junk 数与源系统一致。
- [ ] Cards、List、Map 使用同一地址筛选规则；相同 Suburb/quarter 下统计一致。
- [ ] 地图颜色与三种状态一致：红 `#dc2626` 未发送、紫 `#7c3aed` 已发送、黄 `#eab308` 勿投。
- [ ] 单地址发送、整街发送、Junk/Unjunk、返回 Pending 均有持久化、失败回滚和审计。
- [ ] 计划地址集合没有遗漏/重复，缺坐标地址可见但不会生成伪路线。
- [ ] 起点/预算/手动顺序有效，批次切分不丢地址；算法结果带版本，可复现。
- [ ] “停车—步行—驾车”只在真实停车候选和路由数据可用时自动规划；否则使用人工确认或步行 baseline。
- [ ] 使用脱敏测试数据验证地图、列表、路由、权限与分页后，再运行只读影子比较。
- [ ] 有数据库备份、双写/切换窗口、失败回滚和旧系统只读保留计划。
- [ ] `/admin` 未登录会跳转登录；未获 allowlist 授权的 Google 账号不能进入后台；禁用账号会被服务端及时拒绝。
- [ ] 直接调用每个管理 API 时都会执行服务端 session、用户启用状态、角色和 permission 检查。
- [ ] Preview/Production OAuth redirect URI、独立 session secret、专用数据库账号均已配置；仓库和文档不包含实际密钥。
- [ ] 数据库连接失败、OAuth callback 错误、权限拒绝均有脱敏日志和可操作错误提示。

## 13. 仓库实现索引

- 页面/视图：[app/admin/outreach/OutreachPageClient.tsx](../../app/admin/outreach/OutreachPageClient.tsx)、[app/admin/outreach/page.tsx](../../app/admin/outreach/page.tsx)
- 地图组件：[app/admin/outreach/components/OutreachMapView.tsx](../../app/admin/outreach/components/OutreachMapView.tsx)、[app/admin/outreach/components/DynamicMapView.tsx](../../app/admin/outreach/components/DynamicMapView.tsx)
- 街道与运行侧栏：[app/admin/outreach/components/TodayRunSection.tsx](../../app/admin/outreach/components/TodayRunSection.tsx)、[app/admin/outreach/components/OutreachMapSidebar.tsx](../../app/admin/outreach/components/OutreachMapSidebar.tsx)、[app/admin/outreach/components/OutreachMapToolbar.tsx](../../app/admin/outreach/components/OutreachMapToolbar.tsx)
- 颜色/坐标/排序：[lib/outreach-map.ts](../../lib/outreach-map.ts)、[lib/outreach-streets.ts](../../lib/outreach-streets.ts)、[lib/street-ordering.ts](../../lib/street-ordering.ts)、[lib/street-clustering.ts](../../lib/street-clustering.ts)、[lib/street-cluster-reorder.ts](../../lib/street-cluster-reorder.ts)、[lib/outreach-filter.ts](../../lib/outreach-filter.ts)
- 区域常量：[lib/geo-data.ts](../../lib/geo-data.ts)、[lib/suburb-order.ts](../../lib/suburb-order.ts)
- 登录/权限参考：[lib/auth.config.ts](../../lib/auth.config.ts)、[lib/auth.ts](../../lib/auth.ts)、[lib/permissions.ts](../../lib/permissions.ts)、[middleware.ts](../../middleware.ts)、[app/admin/login/page.tsx](../../app/admin/login/page.tsx)、[.env.local.example](../../.env.local.example)
- 管理员数据结构参考：[database/schema.sql](../../database/schema.sql)
- API 与数据库：[app/api/admin/outreach/street-clusters/route.ts](../../app/api/admin/outreach/street-clusters/route.ts)、[app/api/admin/outreach/street-order/route.ts](../../app/api/admin/outreach/street-order/route.ts)、[app/api/admin/outreach/send/route.ts](../../app/api/admin/outreach/send/route.ts)、[app/api/admin/outreach/nearby-streets/route.ts](../../app/api/admin/outreach/nearby-streets/route.ts)、[lib/db.ts](../../lib/db.ts)
- 结构迁移：[database/migrations/012_create_outreach_tables.sql](../../database/migrations/012_create_outreach_tables.sql)、[database/migrations/039_create_street_locations.sql](../../database/migrations/039_create_street_locations.sql)、[database/migrations/033_create_outreach_materialized_view.sql](../../database/migrations/033_create_outreach_materialized_view.sql)、[migrations/001_quarter_aware_outreach_status.sql](../../migrations/001_quarter_aware_outreach_status.sql)
