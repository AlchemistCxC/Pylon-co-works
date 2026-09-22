# mem-accounting · 进程簇内存的**去重**核算

Windows 上把浏览器型进程簇（Pylon：`pylon.exe` + WebView2 的 browser / GPU / renderer / utility / crashpad）
的内存**按进程相加**会系统性高估：同一份 `msedge.dll`（332 MB 镜像）被 5–7 个进程各自映射，
它的常驻页在每个进程的工作集里都算一遍，物理上却只有一份。

这个脚本给出两个口径，并把「谁被重复算了」列出来。

## 用法

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mem-accounting\mem-accounting.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mem-accounting\mem-accounting.ps1 -Json
powershell -NoProfile -ExecutionPolicy Bypass -File tools\mem-accounting\mem-accounting.ps1 -ProcessName foo.exe
```

需要目标进程在运行（脚本自己找进程树，不需要传 PID）。

## 输出的两个口径

| 口径 | 含义 | 谁在用 |
| --- | --- | --- |
| **私有工作集之和**（`PrivateWS`/`private/resident`） | 只算各进程**独占**的常驻页——共享页天然只算一次 | **任务管理器**的 `Memory` 列（Win10/11 的 Processes 页即此口径）。所以 TM 显示的数**不存在重复计数** |
| **工作集之和**（`WS sum`） | 各进程常驻页直接相加——**同一个物理页会被算 N 次** | 资源监视器 / 你自己把 Details 的 `Working set` 列加起来时。这个数不能用来说「占了多少物理内存」 |

脚本另给一个**去重物理估计**：`私有 + 文件映射并集 + 匿名共享[max..sum]`。

## 去重是怎么做的

1. `VirtualQueryEx` 走完每个进程的地址空间，把 `MEM_COMMIT` 的区域按类型分类
   （`MEM_IMAGE` / `MEM_MAPPED` 文件支撑 / `MEM_MAPPED` 匿名 / 其余按私有）。
2. `QueryWorkingSet` 取每个进程的**常驻页**列表，按上一步的区域归类。
3. 文件支撑的页（镜像与文件映射）用 **(映射文件, 页偏移)** 作身份：同一文件同一偏移出现在多个进程里
   就是同一物理页，跨进程取**并集**。
4. 私有页按定义独占 → 求和。
5. **匿名**（pagefile 支撑的 mojo / GPU 共享内存）在用户态拿不到物理帧号，无法精确去重，
   故单独列出并给一个区间：单进程最大值为下界、各进程之和为上界。

## 两个坑（都踩过）

- **`QueryWorkingSet` 不返回条目数**。缓冲区若不清零、按「读到 0 为止」读，会重复读到上一次查询的
  残留页地址，把「某模块驻留」算高（实测 `ntdll.dll` 七个进程页集完全相同却报出 1.6 / 3.2 / 4.7 MB 三种值）。
  脚本清零缓冲区，并按页地址去重后再计数。
- **PowerShell 对泛型 `Dictionary<K,V>` 直接 `foreach` 会把整个字典当成一个元素**
  （`.Key` 为 `$null`），必须用 `.GetEnumerator()`。C# 侧返回的字典因此都用 `GetEnumerator()` 迭代。

## 局限

- 只做**当前时刻**的快照；活着的进程读数会漂（`msedge.dll` 五进程并集在不同时刻实测 88–93 MB）。
- 「文件偏移」对 `MEM_MAPPED` 用 `AllocationBase` 归一化，隐含假设该 section 从文件偏移 0 起——
  对本例（Chromium 的映射方式）成立，其他程序需自行确认。
- 不覆盖内核态占用（池、驱动的非分页内存）、GPU 的显存、以及 standby 列表里的页。
