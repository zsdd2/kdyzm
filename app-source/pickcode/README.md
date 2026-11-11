# 取件助手 App 3.1.51 公开源码

这是已授权发布的 Android / Vue App 生产源码快照。源于 [SongZX0106/PickCode](https://github.com/SongZX0106/PickCode) 的提交 `07f9fed59122d7f2210a825aadedc2a913a83176`，包含当前私人取件助手的后续实现与 B 版界面。原木兰宽松许可证保留在 [LICENSE](LICENSE)。运行源码保持与构建工作区字节一致；`SOURCE-MANIFEST.json` 记录逐文件 SHA-256。

## 构建

需要 Node.js 24.13+、JDK 17、Android SDK 35，并在本机设置 ANDROID_HOME / JAVA_HOME 或 Android Studio SDK 路径。

```sh
npm ci
npm run build:h5
npm run sync:android
cd android
./gradlew assembleDebug
```

Windows 使用 `gradlew.bat assembleDebug`。H5 开发入口是 `npm run dev:h5`（127.0.0.1:5176）。本地安装将使用本机 debug 签名，不能代替官方发布签名覆盖已安装版本；正式升级使用仓库 Release 中已验证同签名的 APK。

## 公开边界

保留全部 App 运行代码、Android 主程序/资源、Gradle wrapper、锁文件、构建脚本，以及 App 共享解析器 `server/src/logistics-rules.js`。后台的完整源码位于此仓库根目录。没有复制生产数据库、短信/订单快照、Cookie、密钥、签名文件、local.properties 等个人 SDK 配置、缓存与 APK。旧下载二维码及一个无调用者的旧图片导出文件不在镜像内。

原始测试集包含用户提供的短信/站点回归样本，开发任务历史也属于私有工作区，因此测试集、`.codex-dev` 和开发会话记录未公开。`verification.config.json` 与现有 verification 脚本原样保留用于说明原工程门禁；`npm test`、`verify:*` 和 `ai:*` 需要受控工作区中的测试/状态文件，在本公开镜像中不可直接完整运行。正式发布的完整测试、Android 测试/lint 和运行界面验收由原工作区完成，并由发布说明报告；本目录不生成或冒充这些成功记录。

B 版全案与 Figma 入口见本仓库 `docs/designs` 中的对应发布设计。
