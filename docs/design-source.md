- Figma：`https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz/...`
- Modbus 官方规范：`https://www.modbus.org/modbus-specifications`；采用 Application Protocol V1.1b3 + Serial Line Guide V1.02。
- `00 — 设计规范`：业务与交互语义。
- `01 — 产品界面`：最终视觉与页面状态。
- `02 — 组件规范`：公共组件与状态。
- `99 — Archive`：仅追溯。

### 读取顺序

00 → 01 → 02。

### 冲突规则

协议/数据安全 → project-spec 明确补充/Override → Figma 00 → acceptance 映射 → Figma 01 → Figma 02 → Archive/历史资料。`project-spec.md` 与 Figma 00 重复且未标 Override 时，以 Figma 00 为准。