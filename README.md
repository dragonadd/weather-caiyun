# ☀️ 彩云天气网页版（Cloudflare Worker）

一个把**彩云天气**接口包装成可直接访问网页的 Cloudflare Worker：首页实时天气 + 未来 24 小时 / 多天预报 + 城市切换，另提供 `/api/cities`、`/api/weather` 两个接口，前端、后端全部内嵌在单个 Worker 中。

> [!CAUTION]
> **不要**把 `CITIES`、`CAIYUN_TOKEN` 等**环境变量明文写进仓库**。它们请在 Cloudflare 控制台配置（Settings → Variables and Secrets），配置文件里只留引用说明。

> [!WARNING]
> **环境变量不随 Git 提交**。连接到 Git 部署成功后，必须在 Worker 的 Settings 里重新添加一遍 `CITIES`（或 `city/city1/city2…`）和 `CAIYUN_TOKEN`，再部署一次，否则城市列表为空。

## ✨ 功能特点
1. **首页天气面板：** 实时温度、体感、湿度、风速、气压、能见度、云量、降水、空气质量，一目了然；
2. **未来 24 小时曲线：** 逐小时温度趋势 + 图标 + 降水概率；
3. **未来多天预报：** 逐日最高/最低温、天气与生活指数；
4. **多城市切换：** 顶部下拉框选择城市，当前城市自动记住（localStorage）；
5. **城市配置灵活：** 既支持 JSON 数组，也支持 `city / city1 / city2…` 单个变量逐个添加（见下方变量说明）。

## 🔧 依赖
- 一个 **Cloudflare 账号**；
- 一个 **GitHub / GitLab** 仓库（放 `worker.js` + `wrangler.toml`）；
- **彩云天气** Token（必填，在控制台配置为 `CAIYUN_TOKEN`）。

## 🚀 Workers 部署方法（推荐 · Git 集成）

<details>
<summary><code><strong>「 Workers + Git 部署文字教程 」</strong></code></summary>

### 1. 上传代码到 Git 仓库
   - 把本目录的 **`worker.js`** 和 **`wrangler.toml`** 两个文件推送到你的 GitHub 仓库（可新建或放到已有仓库根目录）。

### 2. 连接到 Cloudflare
   - 打开 Cloudflare 控制台 → **Workers & Pages** → **创建 Worker** → 选择 **连接到 Git**；
   - 选中你刚推送的仓库，Cloudflare 会自动识别 **`wrangler.toml`**（内含 `name = "weather"` 和 `main = "worker.js"`）；
   - 点击 **开始设置 / 保存并部署**，Cloudflare 会在每次 push 后自动构建部署。

### 3. 配置环境变量
   - 进入该 Worker → **Settings → Variables and Secrets** → 添加下面「变量说明」里的变量；
   - 重新部署（或稍等自动部署），即可访问 `https://weather.<你的账号>.workers.dev`。

### 4. （可选）绑定自定义域
   - 在 Worker 的 **Settings → Domains & Routes** → **添加自定义域**，填入你的子域名（例如 `weather.example.com`），按提示在 DNS 处添加 CNAME 指向 `weather.<你的账号>.workers.dev` 即可。

</details>

## 📦 Pages 部署方法（备选 · 高级模式）

<details>
<summary><code><strong>「 Pages + Git 部署文字教程 」</strong></code></summary>

> [!NOTE]
> 本方案把文件命名为 **`_worker.js`** 放在 Pages 项目构建输出目录，Pages 会把它当作完整 Worker 运行。仅当你坚持用 Pages 时才选这条。

### 1. 准备文件
   - 把 **`worker.js` 重命名为 `_worker.js`**，放到仓库根目录（本目录未做构建步骤，故输出目录即根目录）。
   - 注意：**`_worker.js` 与 `functions/` 目录二者只能选其一**，不能混用。

### 2. 部署
   - Cloudflare Pages 控制台 → **创建项目 → 连接到 Git** → 选中仓库；
   - 构建配置留空（无需构建命令），输出目录填 **`/`**；
   - 部署后得到 `https://<项目名>.pages.dev`。

### 3. 配置环境变量
   - 项目 → **Settings → Environment variables** → 添加「变量说明」里的变量，重新部署。

</details>

## 📋 变量说明

| 变量名 | 示例 | 必填 | 备注 |
|-|-|-|-|
| CITIES | `[{"name":"北京","lng":116.4074,"lat":39.9042},{"name":"深圳","lng":114.0579,"lat":22.5431}]` | ❌ | 方式 A：用一个 JSON 数组装全部城市；<br>与 `city/city1/…` 同时存在时，**此变量优先** |
| city / city1 / city2 / … | 值一：`北京,116.4074,39.9042`<br>值二：`116.4074,39.9042` | ❌ | 方式 B：**一个变量一个城市**，有几个城市就建几个变量；<br>分隔符支持 `, , ， ; ；、 \|` 或空格；<br>值只有 `经度,纬度` 时，**用变量名当城市名**（如 `city1`） |
| CAIYUN_TOKEN | `XXXXXXXXXXXXXXXX`（示例，勿用真值） | ✅ | 彩云天气 Token（**必填**）；未配置时 `/api/weather` 会直接返回「未配置 CAIYUN_TOKEN」的错误提示 |

> **CITIES 两种写法示例**
>
> 方式 A（一个变量装多个城市，推荐）：
> ```
> CITIES = [{"name":"北京","lng":116.4074,"lat":39.9042},{"name":"深圳","lng":114.0579,"lat":22.5431}]
> ```
>
> 方式 B（一城一变量，想加城市就新增一个）：
> ```
> city1 = 北京,116.4074,39.9042
> city2 = 深圳,114.0579,22.5431
> ```
> 或只写坐标、用变量名当城市名：
> ```
> city1 = 116.4074,39.9042
> city2 = 114.0579,22.5431
> ```

## 🔧 关于 Error 1101 的修复（必读）

原代码 `sortCities()` 里使用了 `a.name.localeCompare(b.name, 'zh-Hans-CN')`。该调用依赖 **ICU 地区数据**，而 Cloudflare Workers 运行时缺少对应数据时会抛出：

```
RangeError: Incorrect locale information provided
```

结果是**所有请求路径**（包括最简单的 `/api/cities`）都返回 **Error 1101 / HTTP 500**。

本版本已做三处修复：
1. **`sortCities()`** 改用纯代码点比较，不再调用 `localeCompare`；
2. **`fetch` 外层加 try/catch 兜底**：之后任何异常会以明文返回（`Worker 内部错误: <原因>`），方便排查，不再笼统 1101；
3. **HTML 城市列表注入改为函数式 `replace`**：避免城市名里的 `$&`、`$'` 被当成替换模式而损坏页面。

> [!TIP]
> 若部署后页面仍报错，直接在浏览器打开地址看返回的明文错误，把那一行发出来即可快速定位。

## ⚠️ 注意事项
1. **环境变量不进仓库**：`CITIES`、`CAIYUN_TOKEN` 在 Cloudflare 控制台配置，commit 里只放 `worker.js` + `wrangler.toml`；
2. **环境变量需重新配置**：每次换新 Worker/Pages 项目都要重新添加一遍变量；
3. **方式 B 城市名**：值里带城市名（`北京,116.4074,39.9042`）时用值里的名；值只有坐标（`116.4074,39.9042`）时用变量名（`city1`）；
4. **Pages 与 Workers 二选一**：用 Pages 高级模式时文件须叫 `_worker.js`，且不能再放 `functions/` 目录；
5. **彩云 Token**（`CAIYUN_TOKEN`）：**必填**，请在控制台以 Secret 方式配置；本仓库已删除代码内置默认值，切勿把真实 Token 写进任何提交，避免被他人消耗额度。

## 🙏 声明
本项目仅供个人学习与日常使用。彩云天气为第三方服务，其接口与计费规则以官方为准，请遵守其服务条款。本项目与彩云天气官方无关联。
