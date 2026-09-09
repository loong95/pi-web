# PlantUML 渲染验收指南

本指南用于验收 Pi Web 的 PlantUML Markdown 预览功能。Pi Web 不会使用公共 PlantUML Server；请使用你控制的服务。

## 1. 准备测试服务器

以下命令使用 PlantUML 官方 Jetty Docker image 在本机启动仅用于验收的服务：

```bash
docker run --rm --name pi-web-plantuml \
  -p 8083:8080 \
  plantuml/plantuml-server:jetty
```

等待容器启动后，Pi Web 中应配置的 **PlantUML Server URL** 是：

```text
http://localhost:8083
```

> Pi Web 配置的是 **`/svg` 前的服务基址**，并自行拼接 `/svg/<encoded-diagram>`。
>
> 上面官方 Docker image 在当前部署方式下把 SVG endpoint 暴露在根路径，因此填写 `http://localhost:8083`，**不要**追加 `/plantuml`。如果你通过 Tomcat、反向代理或 WAR 把服务挂在 `/plantuml`，则填写 `https://your-host/plantuml`。
>
> Pi Web 仅允许 `http:` 用于 loopback 地址（例如 `localhost` 和 `127.0.0.1）。部署在其他机器或内部网络的服务必须通过 HTTPS 访问。

## 2. 配置与连通性

1. 启动 Pi Web，打开 **Settings → General → PlantUML**。
2. 填写上述 Server URL，点击 **Save**。
3. 点击 **Test connection**。
4. 预期结果：出现成功状态；浏览器开发者工具中不应显示对 PlantUML Server 的直接请求，只有对 Pi Web 本地 `/api/plantuml/*` 的请求。
5. 点击 **Clear server**，刷新或重新打开任意带 PlantUML 代码块的 Markdown。
6. 预期结果：代码块以普通源码显示；不显示渲染错误，也不请求 `/api/plantuml/render`。

## 3. 聊天消息预览

向 Pi Web 会话发送下列内容：

````markdown
```plantuml
@startuml
Alice -> Bob: Hello
Bob --> Alice: Hi
@enduml
```
````

验收：

- 流式生成期间显示源码，Preview 不可用；完成后自动显示图表。
- **Source** 可回到源码，**Preview** 可重新渲染图表。
- 点击图表打开查看器；验证放大、缩小、重置/适配宽度和关闭按钮。
- 点击 **SVG** 下载，下载文件应能作为 SVG 打开。
- 服务停止或 URL 错误时，显示渲染失败信息，但源码仍然可见和可复制。

## 4. Markdown 文件预览与语言别名

在工作区创建一个 `.md` 文件，依次加入三种 fenced-code language：

````markdown
```plantuml
@startuml
Alice -> Bob: plantuml
@enduml
```

```puml
@startuml
Alice -> Bob: puml
@enduml
```

```wsd
@startuml
Alice -> Bob: wsd
@enduml
```
````

在 Pi Web 文件查看器切换到 **Preview**。预期三张图均正确渲染，并且每张都具备源码切换、查看器和 SVG 下载。

## 5. 安全与隐私复核

在 Settings 输入以下值，点击 Save；预期均被拒绝且不保存：

- `http://plantuml.example.test/plantuml`（非 loopback HTTP）
- `https://user:password@plantuml.example.test/plantuml`（URL credentials）
- `https://plantuml.example.test/plantuml?token=value`（query）
- `ftp://plantuml.example.test/plantuml`（非 HTTP(S) 协议）

确认应用不会把图表源码写入磁盘缓存。Pi Web 的 render response 应带有：

```text
Cache-Control: no-store
X-Content-Type-Options: nosniff
Content-Type: image/svg+xml; charset=utf-8
```

## 6. 验收记录

请记录：

- Pi Web 版本/commit；
- 使用的 PlantUML Server image 或部署版本；
- 服务 URL（可隐藏域名）；
- 第 2–5 节每项的通过/失败结果；
- 若失败，浏览器 Console、Network 中 Pi Web API 请求的状态码和响应错误文本。

停止临时 Docker 服务：

```bash
docker stop pi-web-plantuml
```
