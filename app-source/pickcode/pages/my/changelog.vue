<template>
  <view class="changelog-container sf-page">
    <view class="version-list" :class="{ expanded: showOlder }">
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.51 · 私人版</text><text class="version-date">2026-11-11</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">电话</text><text class="content">修复圆通姓名后接手机号、顺丰交给联系人等派送文案的号码遗漏</text></view>
          <view class="update-item"><text class="tag optimize">识别</text><text class="content">区分快递员、网点和揽收号码，签收提示不再清空有效派送电话，改派与号码冲突保留未知</text></view>
          <view class="update-item"><text class="tag optimize">兼容</text><text class="content">分别覆盖淘宝、拼多多、京东历史物流句式，已有本地轨迹无需重新采集即可识别</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.50 · 私人版</text><text class="version-date">2026-11-11</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">详情</text><text class="content">送达待确认卡片可打开对应包裹详情，商品名保持一行并支持展开全文</text></view>
          <view class="update-item"><text class="tag optimize">信息</text><text class="content">订单基本信息增加当前运单号和派送员电话，缺少号码时明确提示</text></view>
          <view class="update-item"><text class="tag optimize">电话</text><text class="content">物流中的完整手机号可点击打开拨号界面，不自动呼叫</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.49 · 私人版</text><text class="version-date">2026-11-11</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">待取</text><text class="content">送到门口的包裹直接显示在待取件列表，支持逐件确认收到</text></view>
          <view class="update-item"><text class="tag fix">时间</text><text class="content">京东、顺丰门口送达时间作为到货时间，点击确认收到后记录签收时间</text></view>
          <view class="update-item"><text class="tag optimize">识别</text><text class="content">已合并的旧运单退出异常追踪与重试，保留有效包裹和人工取件决定</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.47 · 私人版</text><text class="version-date">2026-11-11</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">京东</text><text class="content">仓库准备与等待揽收保持待发货，明确揽收才记录发货时间</text></view>
          <view class="update-item"><text class="tag optimize">动画</text><text class="content">每次重新启动后，包裹首次滑到可见位置播放一次小车动画，切换页面不重复播放</text></view>
          <view class="update-item"><text class="tag fix">显示</text><text class="content">避免小车被底部导航遮挡时提前播放，横屏同样支持</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.46 · 私人版</text><text class="version-date">2026-11-10</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">图片</text><text class="content">未收包裹展示平台商品图片，不补采历史订单图片</text></view>
          <view class="update-item"><text class="tag fix">识别</text><text class="content">缺少时间或匹配失败时持续追踪，三次重采后由AI辅助核对，不猜时间或强行匹配</text></view>
          <view class="update-item"><text class="tag optimize">后台</text><text class="content">每天巡检未收包裹，分别优化各平台识别，保留最后一次领取状态更新</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.45 · 私人版</text><text class="version-date">2026-11-10</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">采集</text><text class="content">配套后台每个平台15分钟自动采集，京东、拼多多、淘宝错开约5分钟</text></view>
          <view class="update-item"><text class="tag optimize">刷新</text><text class="content">打开先读取已有数据，整账号采集超过30分钟才自动补采集，手动刷新仍可主动获取</text></view>
          <view class="update-item"><text class="tag fix">同步</text><text class="content">合并重复请求，保留采集冷却和重试，兼容旧后台与已有缓存</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.44 · 私人版</text><text class="version-date">2026-11-10</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">淘宝</text><text class="content">修复明确已取却未更新状态的问题，完善多包裹物流读取和时间识别</text></view>
          <view class="update-item"><text class="tag optimize">读取</text><text class="content">配套后台分别优化京东、拼多多、淘宝的拆单、物流及取件码识别，减少漏读和串包</text></view>
          <view class="update-item"><text class="tag fix">状态</text><text class="content">加强异常时间与冲突轨迹校验，保留可信物流信息和手动取件状态</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.43 · 私人版</text><text class="version-date">2026-11-09</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">识别</text><text class="content">快递超市明确入库轨迹即时识别到货时间，已有站点也可补全遗漏；时间冲突保留待核对</text></view>
          <view class="update-item"><text class="tag optimize">分享</text><text class="content">取件列表新增分享，勾选到货待取包裹生成紧凑票据长图，支持独立取件码、保存图片和系统分享</text></view>
          <view class="update-item"><text class="tag optimize">学习</text><text class="content">配套后台每日检查遗漏物流表达，共用现有AI额度，显示实际应用及回填结果</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.42 · 私人版</text><text class="version-date">2026-11-09</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">修复Android内物流站台、公路及小车图片加载失败，取件卡片、包裹记录和订单详情恢复完整素材与动效</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.41 · 私人版</text><text class="version-date">2026-11-09</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">进度</text><text class="content">物流进度改为微缩站台与纸箱拖车，打开直接显示当前阶段，新的物流事件到达后才播放行程并点亮站牌</text></view>
          <view class="update-item"><text class="tag optimize">时间</text><text class="content">三段耗时喷印在路面并保留分钟；确认取件后停留片刻，平滑收拢为四个时间和三段耗时记录</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">配套后台补查旧订单缺失的下单时间精度，修复已有下单和发货时间却不显示发货用时的问题</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.40 · 私人版</text><text class="version-date">2026-11-09</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">路牌</text><text class="content">下单、发货、到货、取件改成立体路牌与独立时间牌，实际到达或经过才点亮，未到节点保持灰色</text></view>
          <view class="update-item"><text class="tag optimize">时间</text><text class="content">小车在上车道行驶，下车道显示发货、运输和取件耗时，名称沿道路弯曲排列，进行中用时自动更新</text></view>
          <view class="update-item"><text class="tag optimize">详情</text><text class="content">更换站点与站点名称同行对齐，保留取件码完整单行显示、商品名称展开与原有信息折叠</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.39 · 私人版</text><text class="version-date">2026-11-09</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">进度</text><text class="content">小车按待发货2天、运输3天、待取1天的已过时间显示阶段参考进度，动效更明显，车顶显示快递名称</text></view>
          <view class="update-item"><text class="tag optimize">详情</text><text class="content">取件码缩小并完整单行显示，基本信息精简为订单号、平台、订单状态和快递名称；更换站点移到柜号下方</text></view>
          <view class="update-item"><text class="tag optimize">排版</text><text class="content">修正更多及相关操作按钮的文字居中，保留真实状态、时间证据与原有管理操作</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.38 · 私人版</text><text class="version-date">2026-11-09</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">卡片</text><text class="content">取件卡片增加公路汽车动效，包裹记录展示下单、发货、到站和取件四个时间及阶段耗时</text></view>
          <view class="update-item"><text class="tag optimize">详情</text><text class="content">突出货物名称、状态和取件码，货名默认15字可展开；短信原文、物流轨迹和基本信息点击查看</text></view>
          <view class="update-item"><text class="tag optimize">时间</text><text class="content">配合后台 3.1.34 保留可靠的发货和领取时间，兼容无订单取件码及离线确认；缺失时间保持未知</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.37 · 私人版</text><text class="version-date">2026-11-09</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">显示</text><text class="content">打开“我的”和线上账号时先显示本地已有数据，再连接后台更新；连接中或失败时保留已有内容</text></view>
          <view class="update-item"><text class="tag optimize">速度</text><text class="content">轻量读取统计和账号，复用本地快照，减少同步重复计算并合并重叠的自动同步请求</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.36 · 私人版</text><text class="version-date">2026-11-08</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">同步</text><text class="content">配合后台 3.1.32 连续处理全部待查物流，逐项更新结果并显示查询进度，中断后自动接续</text></view>
          <view class="update-item"><text class="tag optimize">准确</text><text class="content">按平台真实分包分别查询，复用在途刷新，相同物流不重复解析，保留取件码绑定和人工决定</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.35 · 私人版</text><text class="version-date">2026-11-08</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">物流</text><text class="content">配合后台 3.1.31 保留平台已取件证据，修复明确签收被客服电话话术误判，自动领取后继续保留短信绑定</text></view>
          <view class="update-item"><text class="tag optimize">同步</text><text class="content">减少重复查询并更快展示同步结果，后台以有限并发加快淘宝与拼多多物流获取</text></view>
          <view class="update-item"><text class="tag optimize">卡片</text><text class="content">待发货、运输中移到待收包裹标题下，订单平台、商品和家人列保持对齐</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.34 · 私人版</text><text class="version-date">2026-11-07</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">设计</text><text class="content">全部页面和弹层统一为 B 版细腻柔雾，采用银灰背景、细白边缘和轻透玻璃层次</text></view>
          <view class="update-item"><text class="tag optimize">排版</text><text class="content">统一字体、间距与对齐，突出取件码和柜号，整理设置分组并减少重复信息</text></view>
          <view class="update-item"><text class="tag optimize">兼容</text><text class="content">支持背景模糊时呈现磨砂材质，不支持时使用清晰实色回退；原有取件、匹配、权限和回执流程保留</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.33 · 私人版</text><text class="version-date">2026-11-07</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">修复承运商从泛称变为具体公司后产生的重复包裹，保留真正的分包</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">站点规则优化和一键更新后，重新识别未分类的未取包裹并匹配，保留既有绑定</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">展开历史取件时未取始终在前，同站点内同柜集中排列</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">取件卡突出柜号与取件码，调整字号和对齐，放大右侧取件按钮并显示商品平台</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">通知逐条关闭并保留本机关闭记录，事项有新进展时再次提醒</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.32 · 私人版</text><text class="version-date">2026-11-07</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">超过30天的订单自动进入过期订单，可查看与恢复；已签收标明超期自动确认收到，未签收仅归档</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">取件码未匹配、解除匹配或关联待核对时均可独立领取，不向不确定包裹写入领取结果</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">合并已确认属于同一运单的旧重复记录，保留原始记录、人工决定与离线操作</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">后台说明站点原文缺失原因；自动取件记录在本页展开，查看具体包裹时再打开详情</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.31 · 私人版</text><text class="version-date">2026-11-07</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">普通签收和物流字段缺失保留短信与包裹关联，历史单号和离线取件按原包裹处理</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">明确本人领取自动完成，实际退回标记退回，上门送达等待确认收到</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">更换站点后可直达本次优化进度，查看未提交原因、后台处理和手机规则确认</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">长期未完成包裹保留待办，同单不同进度分别计数，隐藏后可以恢复</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.30 · 私人版</text><text class="version-date">2026-11-06</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">大卡片统一显示代收包裹，待发货和运输中均计入平台数量与列表</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">待取默认全部站点，卡片内部下拉快速筛选，支持上下滑动查看全部取件码</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">取件卡和包裹详情可更换常用站点、恢复自动识别，同码包裹保持一致</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">人工修正优化默认开启，手动匹配和站点纠正定时脱敏提交，后台AI校验后优化并支持撤回回滚</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.29 · 私人版</text><text class="version-date">2026-11-06</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">取件自动监测默认开启，仅确认本人或收件人实际领取后按运单自动完成</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">后台支持多组领取关键词，AI追加并等价优化后经反例校验应用，可回滚；人工撤销优先</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">大卡片保留5.2秒自动切换，改为整页切换，避免滑动叠加造成文字和页脚重叠</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.28 · 私人版</text><text class="version-date">2026-11-05</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">包裹总数只统计待取、运输中和待发货；默认打开最近未收到，已完成独立查看</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">取件列表默认按站点汇总，可切换按时间，保留商品、备注、家人和取件信息</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">大卡片支持站点筛选与六字商品名；路上包裹只显示运输中，平台按钮与标题同排并显示订单数</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">上下筛选独立，支持取件翻页，自动轮播时页码和翻页按钮同步</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.27 · 私人版</text><text class="version-date">2026-11-05</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">取件提醒集中到右上角通知抽屉，待确认、异常、同步分类查看</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">添加取件码提供明确提示，提交中防重复操作，失败保留输入</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">手动快递只记录名称和单号；包裹默认待取，全部放到最后</text></view>
          <view class="update-item"><text class="tag optimize">配套</text><text class="content">后台3.1.24每6小时检查AI，新证据提前处理，所有AI调用每日最多20次</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.26 · 私人版</text><text class="version-date">2026-11-05</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">修复后台已配置AI但手机无法读取的问题，所有AI识别统一跟随后台服务</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">识别“已暂存，取件地址”的完整物流，升级后重算旧缓存并匹配短信</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">没有推荐候选时直接显示可关联包裹，支持按商品、订单号和运单号搜索</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.25 · 私人版</text><text class="version-date">2026-11-05</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">升级后重算旧物流缓存，已确认站点的短信自动重新匹配</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">站点增强自动投递并同步结果，移除 AI 入队的一分钟旧限制</text></view>
          <view class="update-item"><text class="tag feature">配套</text><text class="content">后台支持站点与物流规则自动调优：证据校验后应用，冲突待核对，修改可回滚</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.23 · 私人版</text><text class="version-date">2026-11-05</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">包裹记录改为单页总览，顶部展示平台与进度数量，点击即可组合筛选，轻动效原位更新列表</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">每张订单保留彩色角色票签；角色、时间和隐藏记录集中筛选，详情以底部面板展开</text></view>
          <view class="update-item"><text class="tag feature">调整</text><text class="content">默认显示最近45天全部进度；更早历史可选，仍有未领取取件码的旧订单继续保留</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.22 · 私人版</text><text class="version-date">2026-11-05</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">采集完成但部分日期或物流未提供时单独提示；较新结果更新旧错误，重试真正重新采集</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">启动先显示本地记录与上次同步时间，再获取后台更新；离线保留绑定和历史</text></view>
          <view class="update-item"><text class="tag feature">配套</text><text class="content">后台3.1.17可配置局域网HTTPS地址，App自动优先直连、失败回退外网，更新下载同步使用</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.21 · 私人版</text><text class="version-date">2026-11-03</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">补齐“已暂存至”等物流说法，改善到站时间与站点提取，保留人工状态和安全匹配限制</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">我的 → 物流识别规则，可编辑、启停、测试及恢复默认；仅本机生效，保存后重新核对已有物流</text></view>
          <view class="update-item"><text class="tag feature">配套</text><text class="content">后台3.1.16在服务设置中独立管理物流规则，下次成功采集或刷新时使用</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.20 · 私人版</text><text class="version-date">2026-11-03</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">F角色票签移回平台标题栏右侧，与拼多多、淘宝等平台名称同一行，去除商品区多余留白</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">同日同平台的不同角色分别展示标题票签，同角色多条记录共用票签，长名称省略且已取件仍保留角色颜色</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.19 · 私人版</text><text class="version-date">2026-11-03</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">包裹记录采用F方案右上角角色票签，不同角色使用不同颜色，避开地址内容</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">按角色查看包裹时，点击角色可独立展开或折叠该组记录</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">大卡片仅一个待取包裹时突出显示取件码，两个及以上保留原列表；路上包裹超过两条时缓慢向上轮播</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.18 · 私人版</text><text class="version-date">2026-11-03</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">升级优先检查已绑定后台并下载内置安装包，后台缺包或不可用时自动回退 GitHub</text></view>
          <view class="update-item"><text class="tag feature">配套</text><text class="content">后台3.1.15容器内置升级包，新App发布后自动更新镜像，局域网可直连后台时加快下载</text></view>
          <view class="update-item"><text class="tag optimize">保留</text><text class="content">继续校验包名、版本、摘要和签名，覆盖安装保留原数据，取消下载不会继续切换来源</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.17 · 私人版</text><text class="version-date">2026-11-03</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">首页、包裹记录、取件详情和桌面卡片统一显示已确认站名，柜号标牌放在取件码前</text></view>
          <view class="update-item"><text class="tag fix">配套</text><text class="content">后台3.1.14修复手动AI分析反馈，支持调高每日额度和查看脱敏分析详情；建议仍需人工确认</text></view>
          <view class="update-item"><text class="tag optimize">保留</text><text class="content">原始短信可核对，复制只含取件码；柜号有冲突时不显示，隐私模式同时隐藏柜号和取件码</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.16 · 私人版</text><text class="version-date">2026-11-03</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">同步后台已确认站点别名，保留柜号，改善短信与物流名称不同的匹配</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">可选上传脱敏站名片段和人工匹配站名关系，由后台 AI 整理并人工核对后生效</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">包裹分组改为时间、角色，明确短信识别与订单更新操作</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.15 · 私人版</text><text class="version-date">2026-11-03</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">平台不返回取件码时，按真实到站时间和取件站点自动关联短信；一分钟内双方唯一自动合并</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">取件列表可手动匹配具体包裹，支持搜索、家人平台筛选、多件分配及解除关联</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">保留短信收发时间，多候选需人工核对，解除后不自动连回；已取和归档状态继续保留</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.14 · 私人版</text><text class="version-date">2026-11-01</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">无取件码的送达包裹可在首页、记录页和大组件确认收到，支持逐件收货和撤销</text></view>
          <view class="update-item"><text class="tag fix">调整</text><text class="content">京东有运单号默认显示运输中，到站、送达和已收货状态优先</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.13 · 私人版</text><text class="version-date">2026-11-01</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">大组件保留已生成运单、仍在出库的待发货包裹</text></view>
          <view class="update-item"><text class="tag fix">配套</text><text class="content">后台3.1.10补查京东出库阶段的运单和仓库轨迹，更新后台后同步生效</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.12 · 私人版</text><text class="version-date">2026-11-01</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">大组件路上区补齐京东等待出库、正在出库及暂无运单的待收货订单</text></view>
          <view class="update-item"><text class="tag optimize">调整</text><text class="content">路上包裹增加淘、拼、京来源标记，商品名称最多显示十个字</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.11 · 私人版</text><text class="version-date">2026-11-01</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">支持</text><text class="content">补齐京东线上账号名称和图标，包裹记录沿用现有家人分组与取件操作</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">进入线上账号页读取最新后台快照，及时显示已授权的新增平台账号</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.10 · 私人版</text><text class="version-date">2026-11-01</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">大号卡片的路上包裹排除已签收与已归档订单，多运单只展示仍活动的无代码包裹</text></view>
          <view class="update-item"><text class="tag optimize">调整</text><text class="content">按已确认A稿固定上下分区比例，校正路上区行距、文字对齐和刷新分隔线</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.9 · 私人版</text><text class="version-date">2026-11-01</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">包裹记录采用通栏排版，商品与金额在上，取件码和按钮在下，家人名称以浅灰底纹显示</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">大号桌面卡片分开展示待取快递与路上订单，无取件码也能查看待发货和运输中包裹</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">压缩安装包中的识别库，保留离线扫码、文字识别和原设备兼容范围</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.8 · 私人版</text><text class="version-date">2026-11-01</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">平台账号按家人整组授权，以后新增账号自动包含</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">包裹显示家人标签，可切换按家人分组，共享取件码保持一张卡片</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">线上账号支持扫码、相册二维码和文字授权码识别，核验范围后确认绑定</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.7 · 私人版</text><text class="version-date">2026-10-31</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">配合新版后台同步拼多多待发货订单，发货后继续更新原订单</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">采集冷却期间合并排队，到期自动执行一次；等待期间显示真实进度</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">修正过期冷却提示，后续同步成功后清除旧提示，保留真实失败原因</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.6 · 私人版</text><text class="version-date">2026-10-31</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">已取订单整体灰化，中央斜盖“已取件”红章，取件历史同步展示</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">超过45天的订单自动归拢，可展开查看；仍有未领取取件码时继续保留</text></view>
          <view class="update-item"><text class="tag optimize">保留</text><text class="content">复制号码、查看详情和撤销取件继续可用，未知下单日期暂不归拢</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.5 · 私人版</text><text class="version-date">2026-10-31</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">自动匹配同时刷新线上订单与短信，显示采集进度和失败原因</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">订单卡片展示并复制订单号、快递单号和取件码，支持逐运单领取与撤销</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">单笔订单重新获取日期与物流，支持人工修正日期及恢复平台日期</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">刷新保留详情展开状态，升级补齐已有订单字段，物流失败保留历史轨迹</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.4 · 私人版</text><text class="version-date">2026-10-31</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">我的页面可检查GitHub新版、查看说明、下载并确认安装</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">显示下载进度，支持取消与重试，安装前校验版本、文件及签名</text></view>
          <view class="update-item"><text class="tag optimize">保留</text><text class="content">覆盖安装保留短信、线上绑定与领取记录</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.3 · 私人版</text><text class="version-date">2026-10-31</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag fix">修复</text><text class="content">支持平台详情补全真实下单日期，日期确认后自动重新分组</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">包裹及取件详情可展开查看各运单物流轨迹和最近更新时间</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">查询失败保留已有轨迹，拆单物流独立展示，人工领取状态不受影响</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.1.0 · 私人版</text><text class="version-date">2026-10-30</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">通过服务地址和一次性绑定码接入线上账号，支持手动同步、后台更新与解除设备绑定</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">包裹记录显示线上订单及多运单；到站且有码后进入取件列表</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">取件详情查看关联包裹和全部原短信，支持候选关联、解除关联与换码确认</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">共码多件支持选择领取，先领取后补运单时可确认此前已取的对应包裹</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">离线领取操作恢复连接后同步，人工已取、隐藏及忽略状态保持；物流签收不会自动标记已取</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">保留已取日期折叠与三种桌面卡片，共码多件从卡片进入详情选择</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.0.1 · 私人版</text><text class="version-date">2026-10-30</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">已取件默认收起，日期内全部取完后自动折叠</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">点击取件码查看原始短信</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">5×3 桌面卡片，支持点码复制和快捷取件</text></view>
          <view class="update-item"><text class="tag fix">修复</text><text class="content">卡片按实际高度与字号显示记录，避免内容裁切</text></view>
        </view>
      </view>
      <view class="version-item sf-surface">
        <view class="version-header"><text class="version-name">v3.0.0 · 私人版</text><text class="version-date">2026-10-30</text></view>
        <view class="update-list">
          <view class="update-item"><text class="tag feature">新增</text><text class="content">本地识别、到站提醒、忽略来源短信与恢复识别</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">DeepSeek 候选模板，验证后手动保存</text></view>
          <view class="update-item"><text class="tag feature">新增</text><text class="content">约每小时后台扫描、两种尺寸桌面卡片与隐私显示</text></view>
          <view class="update-item"><text class="tag optimize">优化</text><text class="content">保留手工修正与已取状态，移除对外推广入口</text></view>
        </view>
      </view>
      <!-- 1.0.1 -->
      <view class="version-item sf-surface">
        <view class="version-header">
          <text class="version-name">v1.0.1</text>
          <text class="version-date">2024-03-21</text>
        </view>
        <view class="update-list">
          <view class="update-item">
            <text class="tag feature">新增</text>
            <text class="content">添加预制匹配规则功能</text>
          </view>
          <view class="update-item">
            <text class="tag feature">新增</text>
            <text class="content">添加软件介绍和更新记录</text>
          </view>
          <view class="update-item">
            <text class="tag optimize">优化</text>
            <text class="content">优化取件码列表显示效果</text>
          </view>
          <view class="update-item">
            <text class="tag fix">修复</text>
            <text class="content">修复部分机型无法正确读取短信的问题</text>
          </view>
        </view>
      </view>

      <!-- 1.0.0 -->
      <view class="version-item sf-surface">
        <view class="version-header">
          <text class="version-name">v1.0.0</text>
          <text class="version-date">2024-03-20</text>
        </view>
        <view class="update-list">
          <view class="update-item">
            <text class="tag feature">新增</text>
            <text class="content">首次发布</text>
          </view>
          <view class="update-item">
            <text class="tag feature">新增</text>
            <text class="content">支持自定义匹配规则</text>
          </view>
          <view class="update-item">
            <text class="tag feature">新增</text>
            <text class="content">支持自动读取短信提取取件码</text>
          </view>
          <view class="update-item">
            <text class="tag feature">新增</text>
            <text class="content">支持取件码历史记录管理</text>
          </view>
        </view>
      </view>
    </view>
    <button class="history-toggle sf-surface" :aria-expanded="showOlder" @click="showOlder = !showOlder">{{ showOlder ? '收起更早更新' : '查看更早更新' }}</button>
  </view>
</template>

<script>
export default { data() { return { showOlder: false }; } };
</script>

<style lang="scss" scoped>
.changelog-container { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.version-item { border-radius: 24px; padding: 18px; margin-bottom: 14px; }.version-list:not(.expanded) .version-item:not(:first-child) { display: none; }.version-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px 12px; margin-bottom: 16px; }.version-name { font-size: 17px; font-weight: 650; color: var(--sf-text); }.version-date { font-size: 13px; color: var(--sf-muted); }.update-item { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; }.update-item:last-child { margin-bottom: 0; }.tag { flex: none; padding: 3px 7px; border-radius: 7px; font-size: 12px; line-height: 18px; background: rgba(8,103,255,.08); color: var(--sf-blue); }.tag.fix { background: #f5ead8; color: #885500; }.content { flex: 1; min-width: 0; font-size: 15px; color: var(--sf-muted); line-height: 1.7; }.history-toggle { width: 100%; min-height: 48px; height: auto; padding: 12px; color: var(--sf-blue); border-radius: 16px; font-size: 15px; line-height: 1.5; }.history-toggle::after { border: 0; }
</style>
