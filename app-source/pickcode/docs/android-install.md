# 本地雷电覆盖安装

Android 以 `applicationId` 区分 App。正式包固定为 `local.pickcode.assistant`；`.benchmark` 和旧 `.task051qa` 是独立 App，即使显示名称和签名相同，也不会覆盖正式包。[Android 官方说明](https://developer.android.com/build/configure-app-module)

统一使用 `android/install.ps1`。它按名称找到普通「雷电模拟器」，核实实例与 ADB 序列号，检查 APK 包名、签名和版本。默认目标是正式包；使用 `adb install -r` 保留数据，安装后校验 APK 哈希。相同 APK 已安装时直接复用。签名不匹配、版本降级或安装失败会停止，不会卸载、清数据或自动重试。[ADB 官方说明](https://developer.android.com/tools/adb)

从项目目录运行只读预检（会读取已安装 APK 元数据，不读取业务数据）：

```powershell
& ./android/install.ps1 -CheckOnly
```

确认已有安装授权后运行覆盖安装，默认使用 `android/app/build/outputs/apk/debug/app-debug.apk`：

```powershell
& ./android/install.ps1
# 或明确指定已核验的正式 APK
& ./android/install.ps1 -Apk 'C:/path/to/pickcode.apk'
```

基准测试必须明确传 `-Target Benchmark` 或 `-Target BenchmarkTest`，继续复用 `local.pickcode.assistant.benchmark` 和 `.benchmark.test`，不要增加任务编号包名。新准备的基准包显示为「取件码助手·基准测试」；安装入口拒绝仍显示正式名称的旧基准 APK。测试运行包没有桌面图标。基准数据隔离仍然保留，不能拿它覆盖或迁移正式数据。

脚本不会启动 App、启动基准测试、操作 JDYK、更新 NAS 或上传文件。已经存在的旧 QA 包保留原状；是否清理它属于单独的数据与卸载决定。

工具定向回归：`pwsh -NoProfile -File tests/android-install.test.ps1`。该测试仅使用模拟命令，不访问设备。
