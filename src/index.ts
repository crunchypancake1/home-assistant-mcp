import { HomeAssistantMCP } from "./agent";

export { HomeAssistantMCP };

export default {
  ...HomeAssistantMCP.serve("/mcp", { binding: "HA_MCP" }),
};
