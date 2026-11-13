# App 同步协议 v1（3.2.0 规范投影）

3.2.0 手机使用 `GET /v1/snapshot?view=compact&dataVersion=<64位hex，可省略>`。
`projectionVersion:2` 与 `dataVersion` 标识轻量实体版本。版本未变时 `metadataOnly:true`，省略订单、运单、标识、别名、隐藏/删除及事件数组；客户端必须已有相同 `dataVersion` 才能应用元数据。授权范围或业务实体变化返回完整轻量实体；纯检查时间不推动实体版本。

每个运单的 `platformView.version=1` 统一提供状态、送达方式、`awaitingShipment`、是否待人工确认、站点/原始位置/柜位、派送员号码、字段质量和 `evidenceKey`。手机保留短信匹配和人工覆盖，不再次解析平台物流。详见 `docs/backend-order-authority-upgrade.md`。

设备 `GET /v1/shipments/:id/logistics` 返回 `{shipmentId,orderId,evidenceKey,logisticsState,logisticsEvents,logisticsTruncated}`。ID 为 32 位 hex，历史别名解析后对运单及订单再次校验授权。详情只读、不触发采集；客户端校验当前绑定和证据版本后缓存。

基础 JSON 接口保持 `schemaVersion:1`，3.2.0 App 和后台需成套升级。同步响应 UTF-8 上限 4,000,000 字节，完整快照主体预算 3,800,000 字节；必需实体超限返回 413 `SNAPSHOT_TOO_LARGE`，客户端保留数据及游标。详情轨迹单独限制在 1,800,000 字节并标明截断。入站请求上限不因响应扩大而改变。HTTPS origin不得带路径或凭证。管理接口用`x-admin-token`；设备用`Authorization: Bearer <device token>`，两种身份互不替代。

| 方法与路径 | 权限 / 用途 |
| --- | --- |
| GET /health | 公开存活检查，返回`{ok:true,serviceId}`，不返回业务数据或局域网地址 |
| GET /v1/setup | 公开初始化状态，`initialized,mode,minPasswordLength`，不返回初始化码或密钥 |
| POST /v1/setup | 首次初始化；`{setupCode,password,baseUrl?}`，成功后不可重复初始化 |
| POST /v1/admin/login | 管理员登录；`{password}`，返回`{token,expiresAt}` |
| GET /v1/admin/status | 管理员；服务地址和模式 |
| PATCH /v1/admin/settings | 管理员；`{baseUrl?,lanBaseUrl?}`，设置HTTPS服务地址，缺席保留、空串清除 |
| POST /v1/admin/password | 管理员；`{currentPassword,password}`，改密并返回新`{token,expiresAt}` |
| GET /v1/admin/accounts | 管理员；账号状态及最近全账号采集任务syncJob、响应serverTime，不含Cookie |
| GET /v1/admin/families | 管理员；`{families:[{id,name}]}`，含无账号家人 |
| POST /v1/admin/families | 管理员；`{name}`，返回`{family:{id,name}}` |
| PATCH /v1/admin/families/:id | 管理员；`{name}`，重命名但不改变稳定ID |
| POST /v1/admin/accounts | 管理员；添加账号，`platform,label,cookie,enabled?,intervalMinutes?,familyId?` |
| PATCH /v1/admin/accounts/:id | 管理员；更新账号、Cookie或采集设置 |
| POST /v1/admin/accounts/:id/sync | 管理员；请求采集 |
| POST /v1/pairing-codes | 管理员；`{familyIds:[...]}`持续家人组授权，或旧`{accountIds:[...]}`，两种输入互斥；返回一次性码及二维码 |
| POST /v1/pairing-codes/preview | 公开限频；`{code}`，不消耗码的服务及授权范围预检 |
| GET /v1/admin/devices | 管理员；设备及授权范围 |
| PATCH /v1/admin/devices/:id | 管理员；`{familyIds?,accountIds?}`，缺席保留、空数组清除对应权限 |
| DELETE /v1/devices/:id | 管理员；撤销指定设备 |
| POST /v1/devices | 公开限频；`{code,deviceName}`兑换token、deviceId、accounts、families、familyIds |
| DELETE /v1/devices/current | 设备；撤销自己 |
| GET /v1/accounts | 设备；只返回获授权账号 |
| GET /v1/connection | 设备；`{schemaVersion:1,serviceId,lanBaseUrl}`，只应经已绑定可信地址获取 |
| POST /v1/accounts/sync | 设备；请求获授权账号采集，可选布尔 `onlyIfStale`，不是同步完成回执 |
| GET /v1/snapshot | 设备；完整快照，支持ETag/If-None-Match/304 |
| POST /v1/operations | 设备；批量幂等人工操作 |

## 服务端3.1.1初始化与管理会话

新部署无须提供密钥环境变量。服务生成持久Cookie加密密钥，并在尚未初始化时将一次性初始化码写入容器日志。`POST /v1/setup`要求正确初始化码与12–128字符密码；`baseUrl`可暂为空，否则须为HTTPS origin。成功返回`{initialized:true}`，重复初始化返回409。初始化前业务接口返回409 `SETUP_REQUIRED`。初始化和登录共享限频；服务不会将密码或密钥返回网页。

登录成功后，将返回的token放入`x-admin-token`。会话有效8小时，仅在服务内存中保存，重启即失效；网页也仅在内存保存，刷新页面需要重登。修改密码撤销旧管理会话并为当前请求返回新会话；当前密码错误返回401 `PASSWORD_INVALID`，不撤销会话。会话无效或过期返回401 `ADMIN_UNAUTHORIZED`。设置地址返回`{configurationMode,baseUrl}`；状态接口为`{fixture,baseUrl,configurationMode}`。地址未设置时生成绑定码返回409 `BASE_URL_REQUIRED`。

已有3.1.0部署保留原三项环境变量即可继续运行，`mode/configurationMode`为`environment`。登录密码填原`ADMIN_TOKEN`，原token直接鉴权仍兼容；设置和改密接口返回409 `ENVIRONMENT_READ_ONLY`。首次设置模式为`managed`，不能与旧环境变量配置混用。设备token、绑定和快照协议保持兼容；管理改密不撤销已绑定设备。

管理页面可从同Host的可信内网HTTP地址初始化；公网使用HTTPS反向代理，并保留原始Host。跨来源请求默认拒绝，原生App的无Origin设备请求仍按设备token鉴权。

## 快照与设备操作

订单可选 `imageUrl` 为本订单商品列表中首张有效商品图。仅接受 `alicdn.com`、`360buyimg.com`、`pddpic.com` 及子域、`img.yangkeduo.com` 的 HTTPS URL（平台 HTTP/无协议地址归一化为 HTTPS），不携设备令牌。缺失或不合法的后续图片不清除已存图片；旧客户端可忽略新字段。超大快照在保留订单与物流数据的前提下省略较早订单的图片地址，数据库不变；客户端缺图或加载失败使用占位图。

快照结构：`{schemaVersion:1,serverRevision,accounts,orders,shipments,hiddenIds,deletedIds}`，可有附加警告字段。订单有`id,accountId,platform,platformOrderId,title,amount,orderDate,orderStatus,refundStatus`；金额缺失为null。运单有`id,orderId,accountId,waybillNo,carrier,status,pickupCode,station,arrivalAt,updatedAt,picked,hidden`。status为`transit/arrived/signed/unknown`，普通signed不派生picked。到站时间是首次已知时间，不随刷新改变。数组缺席不代表删除或已取。

### 家人归属与持续组授权

家人是`{id,name}`。账号新增`familyId,familyName`；`familyId:""`表示待归属，没有待归属伪家人ID。家人可以当前没有账号，仍可整组授权；设备每次请求按保存的`familyIds`解析当前账号，此后新增账号自动包含。暂停采集不会撤销权限。管理家人接口不创建额外登录身份。

旧数据库启动时只补充家人表及设备/绑定码的`family_ids`字段，原账号、订单、运单、设备token、加密凭证及人工操作ID保持不变。旧设备的明确账号权限存为`legacyAccountIds`，不会自动变成家人组授权。设备管理返回`familyIds,legacyAccountIds,accountIds`，其中`accountIds`是当前组账号与旧明确账号权限的并集。修改授权时缺席字段保留，显式`[]`清除；已撤销设备不可通过修改授权恢复。

设备兑换结果和快照增加`familyIds,families,legacyAccountIds`；`GET /v1/accounts`也携带三者。`legacyAccountIds`仅为旧明确账号权限，不能把当前`accounts`动态并集当成旧账号授权。新协议`familyIds`存在时，即使为空，也只按`familyIds`或`legacyAccountIds`判断历史记录权限；旧服务器缺席`familyIds`时客户端才可兼容旧账号范围。账号转组后，原家人的快照可包含历史订单而当前`accounts`为空，客户端应按记录归属导入，不能因此拒绝整个快照。快照的`families`只包含已授权家人及可见账号/记录实际引用的家人，`familyIds`始终表示设备真正持有的持续组权限，不能依据显示名称或`families`数组推导权限。`serverRevision`使用服务全局递增版本，归属、组权限和家人变更会更新快照。

订单与运单新增固化的`familyId,familyName`。记录首次入库时保存归属，新拆分运单继承所属订单的归属；平台输入不能覆写这些字段。旧待归属账号首次显式分配家人时，仅回填该账号尚无家人的既有记录。之后转组或先移回待归属再重新分配，都不会转移非空历史归属；家人重命名也不会改写历史快照名称。账号转组会使当前组账号范围随之改变，新家人组看不到旧家人历史，原家人组仍可读取其历史。转组会使在途采集结果失效，避免旧范围采集结果写入新家人。

家人设备读取快照、领取/隐藏/日期操作、订单详情刷新和对应任务状态，都按记录固化的家人ID校验；整账号采集仍要求当前账号权限。历史记录可能引用已不在`accounts`列表中的账号，客户端应依据记录自身的`platform,familyId,familyName`展示，不可反查当前账号归属覆盖历史。`?accountId=`只缩小已有权限；拥有某账号旧历史的家人仍可用它筛选自己的历史，不能获得该账号新家人的记录。

预检返回`{service:{name,baseUrl},scope:{familyIds,legacyAccountIds,families:[{id,name,accountCount}],accountIds,accounts:[{id,platform,label,familyId,familyName}],includeFutureAccounts},expiresAt}`。家人组模式的`includeFutureAccounts:true`，旧明确账号模式为`false`；摘要不包含Cookie、token、原始授权码、订单、运单或上游错误。预检和兑换共享基于真实连接IP与全局的猜码限频，响应`Cache-Control:no-store`，不信任`X-Forwarded-For`绕过限频。预检不消耗码，兑换时仍在事务内重新检查有效期和一次使用；二维码仍为`{schemaVersion:1,baseUrl,code}`，家人名称以服务端预检为准。

订单新增可选字段 `tradeStatus`（平台交易枚举）、`orderDateSource`（`platform/unknown/legacy`）和 `firstSeenAt`（首次记录时间，缺失为0）。新订单没有真实下单日期时 `orderDate=0`，不得用同步时间代替。历史记录没有来源标识时按 `legacy` 展示待确认，保留原数值；以后采集到真实日期可以补正，已验证的日期保持稳定。旧App忽略附加字段仍可同步，但未知日期和历史筛选需要新版App正确展示。

操作请求：`{operations:[{id,shipmentId,action,occurredAt,pickupCycleId?}]}`，action为`pick/restore/resumeAutoPickup/hide/unhide`，每批1–100条。响应`{appliedIds:[]}`。同设备同ID重放幂等；同ID不同内容返回409；越权批次整体失败。短信正文、解析字段和任意凭证不能经操作接口上行。

### 固定身份与取件周期增量（兼容 v1）

快照的`capabilities`包含`pickup_cycles_v1`，并增加`identity:{version:1}`。`shipmentIdentifiers`是已授权记录的身份索引，条目为`{accountId,platform,shipmentId,originalShipmentId?,orderId,platformPackageKey,carrier,carrierKey,waybillNo,waybillKey,source,createdAt,updatedAt}`。`shipmentId`始终指向快照中的规范运单；历史别名对应的索引保留`originalShipmentId`，但不会把旧ID再次当作活动运单输出。

`shipmentAliases`返回已确认的历史映射：`{oldShipmentId,targetShipmentId,accountId,platform,reason,evidence,createdAt,sourceCycleId?,targetCycleId?}`。快照只输出规范运单；旧ID仍可在原授权范围内解析为目标运单，供历史操作和身份索引使用。`sourceCycleId`与`targetCycleId`固定建立别名时两端的取件周期，用于限制离线操作跨周期迁移。

规范运单可带`pickupCycle:{id,startedAt,evidenceKey,status}`及可选的`pickupCycleHistory`。检测到新的、可信的重新投递/退回等周期重置证据时生成新周期，旧周期保留在历史中；仅重放或更旧的证据不会重复推进周期。旧客户端可以忽略这些字段。

`pick`、`restore`和`resumeAutoPickup`可选提交`pickupCycleId`；旧客户端省略该字段仍按旧请求格式工作。提交周期ID时必须等于当前周期，除非请求使用旧别名且同时满足：周期ID等于别名的`sourceCycleId`，目标运单当前周期等于别名的`targetCycleId`。当前周期已变化、目标周期已再次推进、别名周期不匹配，或无周期ID的离线操作已明显属于保留的旧周期时，返回409 `PICKUP_CYCLE_CONFLICT`，且不记录该操作。

3.1.3新增可选字段，schemaVersion仍为1。订单的`orderDateOrigin=list/detail`区分证据来源，`dateCheckedAt`记录实际详情补查时间。详情日期可以纠正旧列表日期，同一详情的新结果不能被更早的补查或列表值覆盖；人工记录不参与此纠正。

运单新增`logisticsEvents:[{time,timeText,description,location}]`，`time`为毫秒，无法解析为0且保留原`timeText`；`logisticsState=ok/empty/error/unavailable`，未查询时可为空或缺席；`logisticsCheckedAt`与`logisticsUpdatedAt`分别表示最近尝试、最近成功时间。`logisticsTruncated`提示节点已截断。每运单最多100条，description/location/timeText限制为600/120/100字符；同账号同运单的失败或空结果不清旧缓存。快照轨迹预算根据整个JSON实际UTF-8字节数计算，控制在1,900,000字节目标内（基础数据本身已超限的历史边界需另行分页），只裁输出不清数据库。

`logisticsDetailCheckedAt`为采集端内部公平轮询时间，旧客户端可忽略。新增字段不进入设备写操作白名单，仍不能通过App修改平台原始数据。

账号status为expired表示后台更新Cookie，设备仍有效；设备401表示重新绑定。错误JSON形如`{error:{code,message}}`。分页缺失、网络失败和上游过期时保留历史，真实结果以账号状态与lastSuccessAt为准。

## 局域网连接与采集摘要（兼容 v1）

### 定时与条件采集

后台每30秒检查到期账号，独立于手机运行。`intervalMinutes` 支持15/30/60，默认15；京东、拼多多、淘宝分别使用每15分钟周期内第0、5、10分钟开始的窗口。自动采集距离其他平台最近一次开始至少5分钟，服务重启或定时器延迟时不同时补跑三个平台。手动、条件补采集和续跑仍走原任务队列与5分钟账号冷却，不受平台窗口限制。

旧账号缺少 `collectionScheduleVersion:1` 时，首次启动在迁移事务内将间隔改为15、`lastFullSuccessAt` 置0、下一次采集对齐平台时段；账号启停、凭据、权限和订单不变。迁移后手工选择30/60分钟在重启时保留。新增账号和修改采集间隔同样对齐时段。

快照能力 `conditionalSync` 表示支持 `POST /v1/accounts/sync` 的可选 `{onlyIfStale:true}`。服务端仅对当前设备获授权、启用、非expired、无排队/运行任务且整账号采集已过期的账号创建任务。过期为当前时间与 `lastFullSuccessAt` 严格相差超过30分钟；时间缺失、非正安全整数或在未来也视为过期。返回 `{accepted:true,jobs:[]}` 是无需补采集的成功结果。字段不是布尔值返回400；省略或false保留原手动采集行为。

公开账号包含 `enabled,lastFullSuccessAt`。`lastFullSuccessAt` 只在整账号采集任务成功完成后更新，单订单刷新、增量进度和失败不推进；它表示整轮完成，并不保证每个上游字段都有数据，局部警告仍看任务摘要。客户端打开或被动同步先读快照（保留ETag/304），再按此时间决定是否条件采集；设备本地 `online.lastSuccessAt` 与账号 `lastSuccessAt` 均不能替代。旧客户端忽略新增字段；新客户端面对未声明该能力的旧后台仍被动只读。

`lanBaseUrl`默认为空，只接受无路径、查询、片段或凭据的HTTPS origin；后台不猜测容器宿主机地址。管理员在服务设置中配置一次，旧App忽略新字段且旧设置请求不会清除它。环境变量模式使用可选`LAN_BASE_URL`，仍只读；管理模式通过设置保存。实际入口须提供匹配地址且由手机系统信任的有效证书。

`serviceId`为32位小写十六进制稳定实例标识：管理模式随机生成并保存于原配置文件，旧配置仅补缺字段；环境模式由原加密密钥以独立用途HMAC派生，不返回原密钥。备份恢复同一配置保留该标识。它是实例匹配信息而非密码，也不能替代TLS认证。客户端只从原绑定可信HTTPS地址取得连接配置，在候选地址完成TLS校验、匿名`/health`实例匹配后才允许发送设备token；失败继续使用原地址，不能降级HTTP或跟随重定向。

设备快照增加`syncJobs`，最多100条最新的已授权scope摘要。scope为精确`accountId + orderId`，`orderId=''`表示全账号；账号任务按当前账号权限，订单任务按订单固化家人权限过滤。摘要包含原任务字段以及`familyId,createdAt,updatedAt,startedAt?,finishedAt?`；`updatedAt`仅在状态改变并持久化时推进。保留摘要的scope中，新任务`createdAt`严格晚于旧摘要`updatedAt`，且`updatedAt>=createdAt`，保证同毫秒请求、重启或时钟回拨后仍能排序；开始和完成时间保留实际时钟。客户端可用较新的同scope摘要替换缓存终态或确已被替代的较早在途任务，列表缺席不表示该scope成功或可删除；不凭账号`status=ok`抹掉无关失败。旧服务缺少该字段时继续旧轮询方式。

后台持久化每scope最新摘要，最多保留1000条终态及尚在途任务，不保存凭据或上游原文。重启保留终态，将未完成任务明确标为中断错误，不自动重发平台请求；更新登录凭据或账号归属后旧版本摘要不再进入快照。任务变化增加`serverRevision`，且摘要参与快照ETag，稳定状态可返回304。在途和终态均可下发，`empty/unavailable`附带的说明表示平台未提供信息，只有明确`error/expired`等失败状态才当作错误。

## 取件自动监测（兼容 v1）

能力 `pickup_completion_v1` 表示后台逐运单保存自动完成证据。快照根字段 `pickupCompletion={version:1,enabled,aiEnabled}` 只读；两个开关默认均开启。运单增加 `pickupCompletion={version:1,autoPicked,manualOverride,completedAt,evidence}`，`manualOverride` 为 `'' / picked / pending`；`evidence` 为 null 或 `{kind,description,eventTime,fingerprint,ruleId,ruleVersion}`，kind 为 `recipient_signed/user_collected`。原 `picked` 始终是人工覆盖优先后的有效结果，旧客户端继续使用；自动证据不写入 `manualAt`，配置与证据变化进入 revision 和 ETag。

只有明确本人/收件人签收、用户或收件人已取走/领取成功/从柜取出等已完成正文，并具有可信非未来事件时间，才能自动完成。无主体的“取件成功”、普通签收、交易完成、代收、门口、揽收、退回、否定、未来、请求和签收服务说明均不成立；新于或同时发生的待取/重新入库/退回等冲突会使旧证据失效，未知时间的当前冲突也保守阻止自动。不能扫描任意历史命中后永久完成。原始历史截断或失败不单独撤销已保存的有效证据。

启动时给旧记录补充状态，从操作日志识别真实 pick/restore，hide/unhide 与仅有 manualAt 不构成人工取件决定；原已取及隐藏/删除历史保留。当前可见未完成记录使用有效轨迹回查，不发额外平台请求。签收但未领取记录重新进入原有有界、按最早检查时间轮转的物流查询；有效已取件记录停止主动追踪。

`POST /v1/operations` 在原 pick/restore/hide/unhide 之外兼容增加 `resumeAutoPickup`，字段仍为 `{id,shipmentId,action,occurredAt}`。pick/restore 固化 picked/pending 人工覆盖；resumeAutoPickup 清除覆盖并重新应用当前自动证据。跨设备较早 occurredAt 返回成功回执但操作状态为 superseded，不改变更新的人工取件决定；相同时间按接收顺序保留旧接口兼容。相同设备操作ID仍幂等、内容冲突409，全部操作继续检查运单授权。隐藏操作不会改人工取件覆盖。

管理员 `GET/PUT /v1/admin/pickup-completion` 返回 `{config,candidates,history,recent,running,aiReady,stats,monitorRules}`；PUT 只接收布尔 `{enabled?,aiEnabled?}`。monitorRules为只读词组列表，每项包含 `{id,kind,keywords,origin,version,label,isExample,enabled}`；内置示例和真实持久化的AI/人工词组明确区分，多组之间任选命中，组内全部关键词同时出现，命中后仍必须通过完整领取语义与时间校验。关闭 enabled 暂停新自动完成并保留已完成证据；重新开启回查可见记录。`GET /v1/admin/pickup-completion/history` 返回 `{changes,candidates}`，`GET /v1/admin/pickup-completion/candidates` 返回 `{candidates}`；`POST /v1/admin/pickup-completion/rollback` 接收 `{historyId}`。撤回只移除仍与当次应用一致的规则，并同事务重算其自动结果，人工取件/撤销保留。设备令牌没有配置写入或管理历史读取权限。

AI 复用后台默认渠道、全局启用、共享调用额度与冷却，从近期未完成或人工取件记录的原始轨迹中识别明确领取短语，不依赖平台状态必须是signed。原文先通过严格语义校验，只有封闭词表中的主体和完成动作发送到模型。AI选择不同措辞的字面监测词组，去重并移除同组中已被更具体词包含的冗余子串，不扩大匹配范围；新词组经反例与全部缓存轨迹回放后自动追加，多组独立生效。相同证据不重复学习，已回滚候选不重新应用。系统约束提示不由模型自行改写，不接受脚本或正则，也不能放宽否定、疑问、未来、非本人和物流时间顺序保护。关闭开关/变更渠道/关闭服务会废弃在途旧结果，存疑建议留待核对，不直接修改人工状态。

## 站点别名扩展（3.1.13，兼容 v1）

设备快照增加 `stationRulesVersion`（非负整数）和 `stationRules`（启用站点及名称/地区/别名/子位置）。capability 为 `station_aliases_v1`。ETag 同时覆盖站点规则版本。下发不含候选、证据和 AI 配置，未声明能力的旧后台继续使用原匹配。

- 管理员 `GET/POST /v1/admin/stations`，`PATCH /v1/admin/stations/:id`，字段 `name,region,enabled,aliases:[{id?,name,source,subLocation}]`，保存增加规则版本。
- 管理员 `GET /v1/admin/station-candidates`，`POST /v1/admin/station-candidates/:id/approve`（`stationId?,alias?,subLocation?,name?,region?`）或 `/ignore`（空对象）。只有批准写规则。
- 管理员 `GET/PATCH /v1/admin/station-ai`，设置 `channelName,baseUrl,model,apiKey?,clearApiKey?,enabled,intervalMinutes,dailyLimit`。密钥加密；GET 只返回 `hasApiKey/apiKeyMasked`，空值保留，清除须显式指定。`enabled`控制定期及新证据自动分析，已完整配置时关闭自动仍可手动分析。后台3.1.24起 `intervalMinutes` 固定360；兼容接收旧5/60/1440并规范为360。`dailyLimit`默认20且硬上限20，更小额度保留；旧大额度及旧频率在启动时迁移，开关、渠道与凭据不变。`usageToday`为上海时区当天所有渠道、站点、物流、手机模板、连接测试和重试的实际调用数。上传每批20条、候选队列2000条的限制独立于每日额度。
- 管理员 `POST /v1/admin/station-ai/test` 和 `/run` 均为空对象；测试只发固定无隐私JSON。运行返回202及 `{accepted,running,code,message,retryAt?}`。`code`包括 `AI_ACCEPTED/AI_NOT_CONFIGURED/AI_RUNNING/AI_DAILY_LIMIT/AI_NO_PENDING/AI_RETRY_COOLDOWN/SERVICE_STOPPING`；定时器还可能返回 `AI_AUTOMATIC_DISABLED/AI_NOT_DUE`。`retryAt`为等待截止毫秒。请求未接受时不调用模型、不扣额度。失败等待6小时后重试，每候选累计最多3次非取消尝试；`attempts`累计实际调用，`cancelledAttempts`单独记录取消的调用，取消仍扣每日额度，但不耗尽失败重试次数。其余结果按已授权自动调优与校验边界处理。
- 新站名、物流片段或新增独立站点依据持久记录事件，可提前触发；站点和物流共用60秒事件冷却。重复快照、重复候选与重复回执不构成新事件。未知物流的公开站名可进入站点队列，但未确认前不允许物流AI凭空构造依据或直接关联包裹。空队列不调用；额度耗尽后等待上海时区次日恢复。
- 设备 `POST /v1/station-candidates`，`{items:[{id,stationName,fragment,source:'sms'}]}`，最多20项，只允许脱敏站名，返回 `acceptedIds` 供客户端确认。
- 设备 `POST /v1/station-proposals`，`{stationName,otherStationName,subLocation?}`，兼容旧客户端的主动记忆名称关系入口；生成一个保留源→目标与柜号的候选，目标名称不拼入原文充当证据。返回结构保持 `{accepted,duplicates,rejected,acceptedIds,rejectedIds}`。设备不能直接写入共享别名、获取后台AI配置或其他人的候选。

### 人工匹配与站点修正反馈

`matching_feedback_v1` 表示支持设备 `GET/POST /v1/matching-feedback`。未声明能力的旧后台不接收此接口；客户端保留本地修正与待传反馈。无需为每次成功的手动匹配再次勾选上传；常用站点修正立即在本机生效，上传与AI处理异步进行。

POST 请求为 `{items:[{id,revision,action,kind,shipmentId,stationName,otherStationName,targetStationId,subLocation,reason}]}`，每批1–20条。`id`为1–128位字母、数字、下划线或连字符，`revision`为正安全整数，`action`为`upsert/withdraw`；撤回只需`id/revision/action`。upsert的`kind`为`station_correction/manual_match`；前者必须指定已启用的`targetStationId`，后者必须指定授权范围内的内部`shipmentId`。两种反馈均允许空原站名；无原文或目标不明确时保存待核对记录，不能制造证据。站名最多120字，柜号最多60字，后台再次脱敏；不提交短信全文、取件码、手机号、运单号或姓名。`reason`只允许空值或`station_correction/manual_match/station_mismatch/missing_station/ambiguous_match/user_confirmed/other`固定短码。

提交`shipmentId`时按当前设备与历史记录的`canRead`权限核对运单；物流侧站名从该运单读取，不信任客户端的替代文字。手动匹配只有物流站名唯一对应启用站点、目标一致且原站名可学习时才进入站点AI队列。两端已有同站规则但仍无法自动匹配的反馈留待核对，不声称已修复时间、运单或唯一性等其他原因，不改动匹配硬约束。

响应为`{accepted:[{id,revision}],items:[{id,revision,status,candidateId,error,updatedAt}],configured,enabled,autoApply}`。GET省略`accepted`。正常收据状态为`pending/applied/review/failed/withdrawn`；POST被拒单项以`status:'rejected'`、安全短码`error`和`candidateId:''`返回，不进入`accepted`。拒收持久历史供管理员查询，设备GET与快照仍返回正常收据摘要。服务端对拒收只持久化设备、规范化`id/revision`、白名单错误码和时间等最小字段，不保存被拒原始输入；只返回当前设备的收据状态，不返回原文、内部运单ID、其他设备收据或AI密钥。`/v1/snapshot.matchingFeedback`使用相同摘要结构、省略`accepted`，与GET/POST一样返回当前设备全部记录（最多500条），避免离线期间旧样本的最终状态永久遗漏；快照预算预留此元数据大小。状态变更参与快照ETag。

SQLite按认证设备ID+反馈ID保存持久收据。相同版本、相同内容只ACK不重复计数；同版本不同upsert内容拒绝；较旧版本ACK但不覆盖新状态，同版本撤回优先。`accepted`对应收到的请求版本，`items`对应当前服务端版本；客户端只能把相同本地版本的结果用于当前展示，旧响应不得覆盖较新的撤回。相同脱敏映射共用候选，每条收据单独计入来源，撤回只移除本条贡献；最后一份确认撤回时停用候选，若其自动生成别名未被人工修改且没有其他确认来源，则原子回滚该别名。人工修改冲突留管理员核对，其他规则保持不变。取件完成不撤回确认样本；解除或重新匹配必须发送更高版本撤回或替代反馈。

管理员 `GET /v1/admin/matching-feedback` 返回脱敏后的反馈历史及当前可见关联状态，支持`limit`（1–100，默认50）、`before`游标、`status`、`kind`、`reasonCode`、`device`、`station`、`from`和`to`筛选，并以`nextCursor`继续向前分页。正常反馈与`rejected`拒收记录共用一个全局单调、持久稳定的序列游标；`before`严格取该序列之前的记录，不能按设备分别分页，重复同一拒收不会新建历史序列。设备标识使用不透明短标识，不返回设备token；反馈收据、候选/分析、规则应用和设备规则回执分别展示，缺少关联对象时返回空值，不把缺失事实推断为已分析或已生效。分析详情可包含已记录的`analysisAttempts`；`finishedAt=0`不表示分析成功。规则回执的`effectStatus`为`unverified`，只证明版本回执，不证明识别效果。

支持`station_rule_receipts_v1`的设备可`POST /v1/station-rule-receipts`提交`{stationRulesVersion,serverLogisticsRulesVersion}`。成功返回`{accepted:true,receipt:{deviceId,stationRulesVersion,serverLogisticsRulesVersion,receivedAt,effectStatus:'unverified'}}`；同一设备和版本对的重复提交复用原回执。快照同时声明该 capability，旧设备不提交时不视为已取得规则。

分析复用后台默认AI渠道、6小时周期及新证据触发、共享每日最多20次额度和有限重试。AI输入用`confirmedMapping`独立保存脱敏源站名、真实物流站名、目标ID、柜号和固定原因；内部运单/设备/反馈ID不送AI。别名与证据须逐字来自脱敏源片段，不能用目标站名伪造证据。自动应用继续受`enabled/autoApply`配置控制；目标不符、位置编号冲突、已有别名位置不同、原站名不完整或证据不足均留待核对。后台既有AI候选列表显示人工样本、确认关系、状态与原因；已有自动优化记录入口支持审计和保护人工后续修改的回滚。

平台候选仅从有效末端已到站、非已取/隐藏/归档的近期记录收集；AI异步处理与订单采集隔离。短信端默认关闭，开启后本地仅保留7天/200项队列。候选和传输均不含完整短信、取件码、运单、Cookie。修改密码与撤权后接口沿用原认证边界。

候选可附带 `analysis`，仅管理员读取；未曾调用时为null或缺席。结构为 `{startedAt,finishedAt,input,result,error}`，表示候选当前分析摘要；管理员历史可另附已记录的`analysisAttempts`完成/失败快照。每次完成或失败的分析写入事件在写入边界独立记录，即使内容相同也保留独立事件；之后由读取/轮询补录时按分析内容指纹去重，不会因重复读取追加同一完成事件。仅`finishedAt=0`且无错误的进行中状态不计入完成历史。`input`与本次发送给模型的user JSON完全相同，包含脱敏 `fragment,region,knownStations,knownStationsTruncated`；站点上下文超过16KiB时，发送前缩减整个站点条目并设置 `knownStationsTruncated:true`，详情不是完整原始HTTP请求。`result`只保存通过字段、站点ID及原文证据校验的结构；无有效返回时为null，不保存供应商原始内容。`error`只含本地白名单 `code,message`，不保存headers、API Key、供应商原始错误或完整短信。每条analysis最多24KiB；`finishedAt=0`表示尚未完成或中断，不能当成已返回结果。

更换后台AI地址、模型或密钥会使整个旧批次失效，涵盖在途调用、重试等待与候选间隙；旧批次不能转用新渠道，须重新发起分析。清除密钥和服务关闭也会取消；晚到结果不采纳。取消记录本地安全原因，候选可重新分析，已确认或忽略的候选不会恢复待处理。关闭定期分析会取消该定期批次，手动批次不受自动开关影响。已有候选的人工审核与订单采集继续独立运行。所有实际网络请求沿用公网HTTPS、DNS解析校验并固定地址、禁止重定向、超时和响应大小边界。

## 物流明文识别模板（兼容 v1，后台 3.1.16）

后台模板与 App 本机模板独立保存。3.1.22起通过后述独立只读层同步后台模板；本机编辑不上传、不覆盖后台模板。已有站点别名接口保持不变；模板负责从物流正文提取站点与到站证据，不直接确认同站别名或强制合并包裹。

- 管理员 `GET /v1/admin/logistics-rules` 返回 `{revision,rules,defaults}`，初始 revision 为 1。
- 管理员 `PATCH /v1/admin/logistics-rules` 接收 `{revision,rules}`，整体保存并增加版本；过期版本返回 `409 LOGISTICS_RULE_CONFLICT`，不覆盖较新规则。
- 管理员 `POST /v1/admin/logistics-rules/test` 接收 `{rule,sample}`，返回 `{station,arrival,status,ruleId,reason}`。只预览，不保存、不发起采集或 AI。停用规则也可预览，新草稿可传空 ID。
- 规则字段为 `{id,name,enabled,kind,starts,end,keywords,sample,expectedStation,origin}`。`kind=arrival/location`，`origin=builtin/manual`，starts 是 1–20 个字面前文、keywords 是最多 10 个同片段必须包含的关键词；end 为空按标点截断，也支持逗号等字面结束标记。启用前必须用样例准确提取预期站点，到站规则还须验证到站事件。仅支持明文，不接收正则或脚本。
- 最多 100 条、60000 字符，HTTP 请求仍受原 64 KiB 限制；名称/前后文各最多 80 字符，样例 600 字符、站名 120 字符。无效输入返回 `400 INVALID_LOGISTICS_RULE`，保留原配置。

接口沿用 `X-Admin-Token`、来源限制和管理员会话校验，设备 token 无写权限。保存后下一次成功采集或定向刷新按该次采集的模板快照处理；失败保留原证据。保存操作本身不访问平台、不更改旧记录。预计、否定、请求、退回、中转和催取保护固定生效；仅站点位置规则不会生成到站时间。

## Docker 内置 App 更新包

以下只读接口公开且无需凭证，初始化前也可使用：

| 方法与路径 | 响应 |
| --- | --- |
| GET / HEAD /app-updates/app-update.json | 内置发布清单的原始字节；`application/json`、`Cache-Control: no-store` |
| GET / HEAD /app-updates/PickCode-private-&lt;versionName&gt;.apk | 清单对应的唯一版本 APK；`application/vnd.android.package-archive`、`Cache-Control: public, max-age=31536000, immutable` |

两者均返回 `Content-Length` 和以文件 SHA-256 为值的 `ETag`。HEAD 只返回头部，APK 下载流不会为 HEAD 打开。服务启动时校验服务根目录 `app-updates/`（镜像中为 `/app/app-updates`）的清单、APK 大小/流式 SHA-256 与 `SHA256SUMS`，请求时确认已校验文件未变化；缺失或损坏返回 404 / 503，App 可回退 GitHub。更新包校验失败不影响 `/health`、初始化或业务同步。

清单保持现有发布格式与 GitHub 官方固定 `apkUrl`，不会按请求 Host 改写，不返回重定向。客户端可用已绑定后台 origin 加上述固定 APK 路径下载，并继续核对清单大小、摘要和安装签名。此接口无需管理或设备凭证，只公开精确清单和当前版本 APK；其他文件、目录、旧版本及路径穿越均不开放，`SHA256SUMS` 也不对外提供。账号、设备、凭证与业务数据继续使用原有接口鉴权。

## 自动调优与只读物流规则同步（兼容 v1，后台3.1.22 / App3.1.25）

`GET/PATCH /v1/admin/station-ai` 增加布尔 `autoApply` 与 `logisticsEnabled`，默认均为false。前者允许校验通过的自动应用，后者允许物流候选处理；自动运行还受原 `enabled`、有效渠道及共享额度约束。旧客户端不传字段时保留原值。后台界面一次勾选“自动调优（站点＋物流）”保存两者；关闭后站点回到仅建议模式。能力测试可新增 `logistics_rule` 结果，旧结果渲染保持兼容。

自动站点更新只追加唯一且有原文依据的既有启用站点别名，不新建/合并标准站。物流只接受受限字面模板，并验证原始材料、完成到站语义、具体公共站点、固定反例及已有物流语料无回归；缺依据与冲突留待核对。此显式模式取代上文“其余结果仍需人工确认”的限制，未开启时原人工确认流程保持。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| GET /v1/admin/logistics-ai | 管理员；`{candidates,running,dailyLearning}`，候选含状态、脱敏片段、建议及未应用原因；旧客户端可忽略新增每日摘要 |
| POST /v1/admin/logistics-ai/:id/ignore | 管理员；`{}` → `{candidate}`，已应用规则须撤回 |
| GET /v1/admin/ai-optimization/history | 管理员；`{changes}`，每条含id、kind、summary、status、appliedAt、rolledBackAt、canRollback |
| POST /v1/admin/ai-optimization/history/:kind/:id/rollback | 管理员；kind为station_alias或logistics_rule；`{}` → `{change}` |

撤回只移除本次新增且尚未被人工改动的内容，否则409。物流规则保存及缓存重算同事务完成；自动修改记录同事务保存。授权、渠道或开关变化会取消旧模型结果，模型不能执行代码或直接改包裹归属。

设备 `GET /v1/snapshot` 兼容增加 `serverLogisticsRulesVersion` 与 `serverLogisticsRules`。规则只含 `id,name,enabled,kind,starts,end,keywords,origin`，不含管理员原始sample/expectedStation、候选、密钥或其他凭证。ETag包含规则版本。App单独保存并用于重算；同ID本机规则（包括停用）优先，解绑/换绑清除只读层。旧后台缺字段时兼容；旧App忽略新增字段。匹配仍由本机确定性证据及唯一性规则决定。

### 每日物流专项（后台3.1.39）

`dailyLearning` 为只读摘要：`enabled/timezone/hour/nextRunAt/running/timeFormatLearning/lastRun`。北京时间03:00检查存量遗漏，重启优先续跑未完成轮次；沿用`enabled/logisticsEnabled/autoApply`、统一渠道、冷却及每日20次共享上限。无新高频证据不调用AI，忽略和回滚状态不重置。

`lastRun` 分别返回扫描状态、`scanned/changed`、`candidateCount/processedCount`、`states`、`appliedRules/backfilledCount`、当前缺失/未知/冲突计数及脱敏时间形状。扫描完成、候选入队或生成建议不代表已应用或回填；规则回滚后统计随真实数据更新。未知时间格式标为`requires_review`，不生成解析代码、猜测日期或训练模型参数。新增两张内部运行/样本表自动创建，不重建已有订单数据库。

## 手机统一后台 AI 服务（兼容 v1，后台3.1.23 / App3.1.26）

设备 `GET /v1/ai/channels` 返回 `{channels,defaultChannelId,service}`。`channels` 最多只含当前可用默认服务，能力为 `station_alias/sms_template/logistics_rule`；管理端渠道列表仍由 `GET /v1/admin/ai-channels` 返回。设备接口不返回服务地址、密钥或其他管理员配置。

`service` 为 `{mode:'backend_default',available,code,message,channelId,channelName,model,revision}`。`code` 为 `AI_READY/AI_NOT_CONFIGURED/AI_DEFAULT_MISSING/AI_CHANNEL_DISABLED/AI_CHANNEL_INCOMPLETE`；默认服务不可用时仍说明具体原因，`channels=[]`、`defaultChannelId=''`。`available` 表示配置就绪，不代表已测试网络或模型效果。站点定时分析的 `enabled` 开关不阻止手机已授权的短信模板生成。

设备 `POST /v1/ai/template-proposals` 接收 `{sample,expectedCode}`；手机发送本机构造的合成模板，不发送原短信与真实取件码。旧请求可包含当前默认 `channelId`；非默认值返回409 `AI_CONFIG_CHANGED`，不暗中换渠道。默认服务切换、暂停或模型/密钥变化使旧缓存及在途结果失效；额度、认证、隐私和输出校验继续有效。

App不再保存独立渠道选择，不采用列表第一项或本机旧密钥回退。原生状态使用缓存的服务元信息及检查时间，每5秒本机状态刷新不访问后台；手动刷新、开启和实际分析时重新读取，确认建议时再次核对服务版本。已开启授权保留，旧渠道未确认建议清除；旧加密密钥不删除但不再用于调用。旧后台明确返回有效默认服务时兼容，否则显示不可用。

物流解析增加相邻逗号分隔的“已送达…暂存,取件地址:具体站点”证据连接。仅相邻、已完成动作与明确地址生效；未来、否定、上门、途中及不相邻片段不跨界拼接。App物流投影版本2会重算旧缓存，保留人工决定；后台保存历史原文在下次正常采集导入时重算，不执行启动时全库迁移。

## 浏览器 Cookie 同步（兼容 v1）

以下单账号授权独立于管理员会话和手机设备 token，只允许向一个既有的淘宝、拼多多或京东账号提交登录 Cookie。它没有订单读取、设备管理、角色整组或管理员权限；不能创建账号或更改平台、角色、名称、采集开关。服务须先初始化。后述角色授权采用独立接口和 token，旧单账号接口保持兼容。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| POST /v1/admin/cookie-sync/pairing | 管理员；`{accountId}` → `{code,expiresAt,baseUrl}` |
| GET /v1/admin/cookie-sync/connections?accountId=:id | 管理员；`{connections}` |
| DELETE /v1/admin/cookie-sync/connections/:id | 管理员；`{revoked:true}` |
| POST /v1/cookie-sync/pairing/preview | 公开限频；`{code}` → `{account,expiresAt,serviceId}`，不消耗配对码 |
| POST /v1/cookie-sync/connections | 公开限频；`{code,name}` → `{token,connection,account,serviceId}` |
| GET /v1/cookie-sync/current | 插件 Bearer token；`{connection,account,serviceId}` |
| POST /v1/cookie-sync/current/preview | 插件；`{cookie}` → `{confirmationToken,identityHint,account,expiresAt}` |
| POST /v1/cookie-sync/current/cookie | 插件；`{cookie,expectedCredentialVersion,confirmationToken?}` → `{changed,connection,account,serviceId,job?}` |
| DELETE /v1/cookie-sync/current | 插件；`{revoked:true}` |

`account` 仅含 `{id,platform,label,familyId,familyName,credentialVersion,status}`；`connection` 仅含 `{id,name,platform,accountId,createdAt,expiresAt,revokedAt,lastSyncAt,identityBound,identityHint}`。未撤权的 `revokedAt` 为 null、尚未同步的 `lastSyncAt` 为 0。所有响应 `Cache-Control:no-store`，不返回 Cookie、内部身份摘要或已签发的 token；只有兑换成功响应返回一次新 token。名称和角色显示文本不能作为平台账号身份依据。

配对码为 `CS-` 加 43 个 base64url 字符（256 位随机量），有效十分钟，服务端只保存 SHA-256；同账号重新生成码使旧码失效。配对码绑定创建时账号、角色和凭据版本，兑换时重新校验并在事务内单次消耗。预检和兑换共享真实连接 IP 十分钟十次、全局一百次的限频，不信任 `X-Forwarded-For`。管理员每账号十分钟最多生成十次。未过期配对码最多一千条，过期即清理。

插件 token 为 `csg_` 加 43 个 base64url 字符，仅保存 SHA-256，有效九十天。同一账号兑换新授权会立即撤销旧授权；不同账号互不影响。账号角色转移在数据库写入时撤销该账号所有插件授权和待用配对码，转回原角色也不恢复。角色重命名不改变授权。历史撤权/过期连接最多保留一千条，并清理到期三十天以上的记录；总连接数最多五千，达到上限时拒绝新增而不丢弃有效授权。重启保留授权、身份绑定与撤权状态。

仅 `/v1/cookie-sync/` 命名空间接受 `chrome-extension://` 加 32 个 `a`–`p` 字符的来源和预检；其他接口不向扩展来源开放。来源允许不代替 token 鉴权。账号、Cookie 和确认字段均使用白名单，读取完整请求体后再次检查授权，确保在途上传不能越过撤权或转组。

身份只从严格解析的 Cookie header 取得：淘宝 `unb`，拼多多 `pdd_user_id/pdduid`，京东 `pin/pt_pin`（按百分号解码）。同平台多个身份字段必须一致，重复 Cookie 名、缺失/空白身份、冲突、无效编码或控制字符均拒绝；登录字段还须分别包含非空 `cookie2`、`PDDAccessToken`，或京东桌面订单页使用的 `thor/light_key` 二者之一。不把 `flash`、移动端 `pt_key` 或裸 `pin` 代替京东登录态。上传最多 16384 字符，整个 JSON 请求仍受 64 KiB 限制。身份绑定保存带服务密钥的 HMAC-SHA-256，仅展示脱敏尾号。

每个新授权首次上传必须先预览并由用户确认角色和平台账号。确认 token 有效五分钟，只存摘要，绑定授权、完整 Cookie 摘要及账号凭据版本；重新预览替代旧确认，成功上传后清除。已存在后台 Cookie 可解析身份时必须一致；旧凭据缺少身份允许首次明确确认，冲突或格式错误则请管理员先核对。绑定后只接受同一身份的自动续更；管理员换成另一平台身份时旧连接拒绝继续，需重新配对。

`expectedCredentialVersion` 为必填正安全整数，过期版本返回 `409 COOKIE_CREDENTIAL_CONFLICT`，保留原凭据。首次无有效确认返回 `409 COOKIE_CONFIRMATION_REQUIRED`；身份不一致为 `409 COOKIE_IDENTITY_MISMATCH`，已有后台身份异常为 `409 COOKIE_BACKEND_IDENTITY_INVALID`；已绑定身份相符但后台身份丢失也返回后者，必须重新配对并明确确认，不能自动解除绑定。身份缺失、冲突和缺少登录字段分别为 `400 COOKIE_IDENTITY_REQUIRED/COOKIE_IDENTITY_AMBIGUOUS/COOKIE_LOGIN_REQUIRED`；授权过期或撤销为 `401 COOKIE_SYNC_UNAUTHORIZED`；码失效为 `400 COOKIE_PAIRING_INVALID`。

完全相同的 Cookie 返回 `changed:false`，不增加凭据版本、不采集，可更新 `lastSyncAt`。变化则使用原 AES-GCM 加密存储，增加凭据版本使旧采集结果失效，保留原 `lastAttemptAt/nextSyncAt` 冷却与定时设置，并请求一次采集。已有运行采集时在其完成后再次核对授权与凭据版本再请求；期间更新、撤权、转组或关闭服务则取消该次后续请求。原已排队任务可复用并在启动时读新凭据。停用账号不会被启用，五分钟采集冷却仍生效。每授权一分钟最多六次变化写入、一百二十次接口请求，预览最多二十次；限频失败保留原 Cookie。

### 角色级浏览器授权

角色授权包含该角色当前及以后加入的淘宝、拼多多和京东账号，但不含订单、设备或管理员权限。插件须将每个账号的“选中”和“自动同步”默认关闭；每个账号仍单独预览并确认身份后才能写入。空角色也可以授权。角色改名不撤权，账号移出角色则不再可读写；移回时原子授权已永久撤销，客户端看到 `connection:null`，须清除该账号的自动同步选择并重新明确确认。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| POST /v1/admin/cookie-sync/families/pairing | 管理员；`{familyId}` → `{code,expiresAt,baseUrl}` |
| GET /v1/admin/cookie-sync/families/connections?familyId=:id | 管理员；`{connections}` |
| DELETE /v1/admin/cookie-sync/families/connections/:id | 管理员；`{revoked:true}`，同时撤销所有子授权 |
| POST /v1/cookie-sync/families/pairing/preview | 公开限频；`{code}` → `{family,accounts,expiresAt,serviceId}` |
| POST /v1/cookie-sync/families/connections | 公开限频；`{code,name}` → `{token,connection,family,accounts,serviceId}` |
| GET /v1/cookie-sync/families/current | 角色 token；`{connection,family,accounts,serviceId}` |
| DELETE /v1/cookie-sync/families/current | 角色 token；`{revoked:true}` |
| GET /v1/cookie-sync/families/current/accounts/:accountId | 角色 token；`{account,connection,serviceId}` |
| POST /v1/cookie-sync/families/current/accounts/:accountId/preview | 角色 token；`{cookie}` → 原单账号预览字段及 `{connection,serviceId}` |
| POST /v1/cookie-sync/families/current/accounts/:accountId/cookie | 角色 token；请求/响应沿用单账号 Cookie 写入接口 |

角色配对码为 `CF-` 加 43 个 base64url 字符，有效十分钟、单次使用；角色 token 为 `cfg_` 加 43 个 base64url 字符，有效九十天。两者只保存 SHA-256，不能与旧 `CS-/csg_`、设备 token 或管理员会话互换。角色配对预览不继承旧授权，因此其中子连接均为 null；兑换新角色授权时撤销同角色旧父授权及全部子授权，保留已有单账号授权。旧单账号重新兑换沿用原替换行为，撤销对应账号的角色子授权；角色父授权仍有效，但该账号必须重新预览。所有写操作仍复用原身份、确认摘要、凭据版本和冷却检查。

父 `connection` 为 `{id,name,familyId,createdAt,expiresAt,revokedAt}`；`family` 为 `{id,name}`；`accounts` 为 `[{account,connection:null|子连接摘要}]`。子连接摘要与原单账号字段相同，没有子 token。读取不创建子授权，只有成功的明确预览才创建；上传接口不会恢复缺失、过期或撤销的子授权。子授权在父授权到期时一同到期。流式请求在完整读取 JSON 后重新校验父授权、当前角色归属、原子授权 ID 和版本，防止撤权、替换以及转走再转回的旧请求写入。

每父授权每分钟最多 240 次接口调用，每父授权/账号最多 120 次，预览 20 次、变化写入 6 次；限频键不会因子授权重建而重置。配对猜测与旧接口共享 IP/全局限频。角色待用码最多 1000、父连接最多 5000、失效父连接历史最多 1000，并清理到期三十天以上的历史；删除历史父连接只级联清理其子状态。旧 3.1.18 数据库只新增角色相关表及可空 `family_connection_id`，原账号、密文、单账号授权和待用码保持有效。

撤销阻止后续 Cookie 写入及尚未发起的“旧采集完成后再请求”回调；已经由后台接受的共享采集队列仍由原账号调度器管理，不因浏览器退出而取消管理员或其他入口的任务。

### 插件先发起授权与首次建立平台账号

插件可先让用户登录平台，在本机检查登录态，再发起不含 Cookie 的授权申请。管理员仅在可信后台登录并选择角色；插件不接收管理员密码或管理会话。浏览器可打开后台 `/#cookie-sync-request=CR-...`，片段仅包含申请码，不得包含轮询密钥。

| 方法与路径 | 权限与请求/响应 |
| --- | --- |
| POST /v1/cookie-sync/families/requests | 公开限频；`{name,platforms}` → `{requestId,code,pollToken,expiresAt}` |
| POST /v1/cookie-sync/families/requests/poll | 申请轮询密钥；`{requestId,pollToken}` → `{status:'pending',expiresAt}` 或 `{status:'approved',token,connection,family,accounts,serviceId}` |
| GET /v1/admin/cookie-sync/families/requests/:code | 管理员；`{requestId,name,platforms,expiresAt,status}` |
| POST /v1/admin/cookie-sync/families/requests/:code/approve | 管理员；`{familyId}` → `{approved:true}` |
| POST /v1/cookie-sync/families/current/platforms/:platform/preview | 角色 token；`{cookie}` → `{newAccount:true,platform,confirmationToken,identityHint,expiresAt,serviceId}` |
| POST /v1/cookie-sync/families/current/platforms/:platform/cookie | 角色 token；`{cookie,expectedCredentialVersion:0,confirmationToken}` → `{changed:true,account,connection,serviceId,job?}` |

`platforms` 是不重复的非空 `taobao/pdd/jd` 子集，只供管理员了解申请，不改变授权覆盖角色当前及未来账号的范围。申请码为 `CR-` 加 43 个 base64url 字符，轮询密钥为 `cpr_` 加 43 个 base64url 字符，有效十分钟，数据库仅存摘要和非敏感申请元数据。申请创建沿用配对猜测限频、最多 1000 条；轮询每 IP 每分钟 120 次、全局 3000 次。批准只保存角色 ID；首次成功轮询才在事务内消耗申请并签发一次角色 token，重新轮询或过期返回 `400 COOKIE_REQUEST_INVALID`。响应丢失需重新申请，不存可取回的明文 token。重复批准返回 `409 COOKIE_REQUEST_APPROVED`，其他角色或凭证不能代替轮询密钥。

首次建立平台账号仅适用于该角色完全没有该平台账号的情况。预览校验同样的平台身份和登录字段，只保存父授权/平台绑定的 Cookie 摘要、确认 token 摘要和五分钟有效期，不创建账号、不保存 Cookie、不发起采集。用户明确确认后，创建接口再次校验父授权、确认摘要、版本 0 及平台仍然缺席；账号、加密 Cookie、已绑定子授权和确认消耗在一个数据库事务中保存，失败整体回滚。账号名称由角色和平台生成，随后按原调度器请求一次采集。确认凭证不能用于其他角色、平台或 Cookie，撤权即清除。

若预览后已有该平台账号、另一请求先完成创建，或原本存在多个账号，返回 `409 COOKIE_PLATFORM_EXISTS`，不选择或覆盖任何已有账号。已有账号必须使用账号 ID 接口。客户端不能自动调用首次创建接口；应在展示角色、平台和脱敏身份并获得本次批量确认后逐个平台提交。后台创建接口不接受 `enabled`、任意名称、角色或内部事务标志。

## 3.1.44：recognition_workflow_v1

快照在 `capabilities` 增加 `recognition_workflow_v1`，新增 `recognitionIssues` 数组。元素仅有 `{id,revision,status,retryCount,reasonCode,nextRetryAt}`，只包含原上报设备且仍可读候选的问题。状态为 `pending/retrying/ai_pending/ai_running/review/blocked/resolved/ignored`。旧客户端忽略新增字段；客户端只在能力存在时调用新接口。

`POST /v1/recognition-issues` 使用设备 Bearer；请求 `{schemaVersion:1,items:[{id,revision,kind:'unmatched_pickup',state,sourceId,observedAt,source,candidateShipmentIds,reasonCodes}]}`，每批1到20项。`id/sourceId` 为1到128位字母数字下划线或连字符，`revision` 为正安全整数，`observedAt` 不超过服务时间5分钟。`source` 白名单为 station/fragment（120字）、carrier（40）、waybillNo（32）、pickupCode（12）、occurredAt（null或时间，旧0归一null）；原因码最多20个小写字母下划线字符串。

`state` 为 unresolved/resolved/withdrawn。未解决报告仅接受1到20个当前授权、未收的规范运单ID；设备+问题ID隔离幂等，低版本不覆盖高版本。resolved必须是既有同来源问题，由客户端完整匹配后的新版本确认；withdrawn用于忽略、删除、手动解除及失效来源，候选可为空，映射ignored而非resolved。首次上传尚在途时可先保存撤回墓碑，阻止低版本复活；恢复后更高版本仍须通过未收和授权验证。

返回 `{accepted:[{id,revision}],issues:[...]}`，只以精确版本回执确认上传。每设备每小时最多60批；整批格式错误回滚。账号/家人授权在接收完整body后重查；源权限变化阻止重试及AI。三次重试仅按真实采集作业完成计数，同订单问题共用请求，排队/冷却/停用/过期不计数。

管理员只读：`GET /v1/admin/recognition-tasks` 返回策略、分组、最近任务和日报；`GET /v1/admin/recognition-review?limit=100&after=0` 返回schemaVersion、serverVersion、generatedAt、workflow、当前未收samples、learning、aiReviews、rules版本与AI预算。limit为1到100、after为非负整数，nextCursor继续分页；不返回Cookie、设备/管理员token或AI密钥。GET不启动采集或AI。

独立机器诊断：`/v1/diagnostics/` 使用持久、可撤销的 `Authorization: Bearer pcdiag_…` 凭据，不依赖管理员会话。只读白名单包括 `status`、`accounts`、`orders`、`orders/:id`、`recognition-tasks`、`recognition-review`；其他路径不可访问，写方法返回405。管理员通过 `/v1/admin/diagnostic-tokens` 创建/列出，`DELETE /v1/admin/diagnostic-tokens/:id` 撤销。完整凭据仅创建时返回，最多10个有效凭据，仅摘要入库。订单查询分页、时间证据字段与错误码见 [diagnostic-api.md](docs/diagnostic-api.md)。

后台每日03:00巡检独立于AI开关；AI建议和自动应用继续服从原配置与预算。时间与匹配建议固定格式见 `docs/recognition-workflow.md`，原文校验失败不得应用。规则已保存不代表问题已解决。

## 3.1.32 连续物流任务（兼容新增）

任务可包含 `logisticsProgress: {total,completed,active,attempts,durationMs}` 以及 `continuation:boolean`。计数单位是查询任务，不能解释为包裹数；客户端仅接受有限非负数并限制上界100000。`queued + retryAt` 也用于持久续查的退避，`running` 期间新快照可包含已完成部分的订单与物流，账号仍为 `syncing`，整批结束才标记 `ok`。缺失字段的旧服务仍沿用旧提示与轮询。

同账户全量任务可覆盖活跃单单请求，但单单摘要仍有独立id/orderId/familyId，按原订单权限过滤，完成时只汇总该订单数据，不传递全量查询计数或其他订单错误。凭据版本变化使旧检查点无效。SQLite内部 `sync_logistics_tasks` 保存输入及成功结果，不保存cookie、风控令牌或外部任意URL；任务完成后清理检查点。关闭或重启将未完成工作保留为queued，恢复后自动继续；旧版无resumeVersion的遗留中断摘要继续明确报错。
