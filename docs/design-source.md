# 设计与规范来源

- [Figma 设计文件](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz)：[00 — 设计规范](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=80-113)、[01 — 产品界面](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=62-2)、[02 — 组件规范](https://www.figma.com/design/dQmLfIDT6zzIjCr4iFC7Cz?node-id=94-2)。
- [Modbus 官方规范](https://www.modbus.org/modbus-specifications)：Application Protocol V1.1b3 与 Serial Line Guide V1.02。
- `00 — 设计规范`：业务与交互语义；`01 — 产品界面`：页面及状态；`02 — 组件规范`：公共组件。`99 — Archive` 仅供追溯。

## 读取与冲突规则

1. 项目硬约束以 [AGENTS.md](../AGENTS.md) 为准；线协议的合法性与尺寸以官方 Modbus 规范为准。工程上不采用 RTU 字符间隔判帧的显式决策见[架构](architecture.md)和[RTU 分帧说明](protocol/02-rtu-framing.md)。
2. 产品行为以 [project-spec.md](project-spec.md) 的明确补充或 Override 为准；未标明补充或 Override、且与 Figma `00` 重复的内容，以 Figma `00` 为准。
3. 未被上述来源规定的页面与组件细节，依次参考 Figma `01`、`02`；实现机制见 [architecture.md](architecture.md)。
4. [acceptance.md](acceptance.md) 是验收条件，[full-audit.md](full-audit.md) 是历史证据，均不替代需求或设计来源；Archive 也不作为当前规范。
