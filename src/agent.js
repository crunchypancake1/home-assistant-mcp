var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HomeAssistantClient } from "./ha/api";
var HomeAssistantMCP = /** @class */ (function (_super) {
    __extends(HomeAssistantMCP, _super);
    function HomeAssistantMCP() {
        var _this = _super !== null && _super.apply(this, arguments) || this;
        _this.server = new McpServer({ name: "Home Assistant", version: "1.0.0" });
        return _this;
    }
    HomeAssistantMCP.prototype.init = function () {
        return __awaiter(this, void 0, void 0, function () {
            var client;
            var _this = this;
            return __generator(this, function (_a) {
                client = new HomeAssistantClient(this.env.HA_URL, this.env.HA_TOKEN);
                this.server.registerTool("get_entities", {
                    description: "List Home Assistant entity states, optionally filtered by domain (e.g. 'light', 'switch', 'sensor').",
                    inputSchema: {
                        domain: z
                            .string()
                            .optional()
                            .describe("Entity domain to filter by (e.g. 'light', 'sensor', 'switch')"),
                    },
                }, function (_a) { return __awaiter(_this, [_a], void 0, function (_b) {
                    var states;
                    var domain = _b.domain;
                    return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0: return [4 /*yield*/, client.getStates(domain)];
                            case 1:
                                states = _c.sent();
                                return [2 /*return*/, { content: [{ type: "text", text: JSON.stringify(states) }] }];
                        }
                    });
                }); });
                this.server.registerTool("get_entity_state", {
                    description: "Get the full state and attributes of a specific Home Assistant entity.",
                    inputSchema: {
                        entity_id: z
                            .string()
                            .describe("Entity ID (e.g. 'light.living_room', 'sensor.temperature')"),
                    },
                }, function (_a) { return __awaiter(_this, [_a], void 0, function (_b) {
                    var state;
                    var entity_id = _b.entity_id;
                    return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0: return [4 /*yield*/, client.getEntityState(entity_id)];
                            case 1:
                                state = _c.sent();
                                if (state === null) {
                                    return [2 /*return*/, {
                                            content: [{ type: "text", text: "Entity not found: ".concat(entity_id) }],
                                            isError: true,
                                        }];
                                }
                                return [2 /*return*/, { content: [{ type: "text", text: JSON.stringify(state) }] }];
                        }
                    });
                }); });
                this.server.registerTool("call_service", {
                    description: "Call a Home Assistant service (e.g. turn lights on/off, lock a door). Pass service_data directly to HA.",
                    inputSchema: {
                        domain: z
                            .string()
                            .describe("Service domain (e.g. 'light', 'switch', 'homeassistant')"),
                        service: z
                            .string()
                            .describe("Service name (e.g. 'turn_on', 'turn_off', 'toggle')"),
                        service_data: z
                            .record(z.unknown())
                            .optional()
                            .describe("Service data payload (e.g. { entity_id: 'light.living_room', brightness: 128 })"),
                    },
                }, function (_a) { return __awaiter(_this, [_a], void 0, function (_b) {
                    var affected, text;
                    var domain = _b.domain, service = _b.service, service_data = _b.service_data;
                    return __generator(this, function (_c) {
                        switch (_c.label) {
                            case 0: return [4 /*yield*/, client.callService(domain, service, service_data !== null && service_data !== void 0 ? service_data : {})];
                            case 1:
                                affected = _c.sent();
                                text = affected.length === 0
                                    ? "Service ".concat(domain, ".").concat(service, " called successfully (no affected entities returned).")
                                    : JSON.stringify(affected);
                                return [2 /*return*/, { content: [{ type: "text", text: text }] }];
                        }
                    });
                }); });
                this.server.registerTool("list_areas", {
                    description: "List all configured areas (rooms) in Home Assistant.",
                    inputSchema: {},
                }, function () { return __awaiter(_this, void 0, void 0, function () {
                    var areas;
                    return __generator(this, function (_a) {
                        switch (_a.label) {
                            case 0: return [4 /*yield*/, client.listAreas()];
                            case 1:
                                areas = _a.sent();
                                return [2 /*return*/, { content: [{ type: "text", text: JSON.stringify(areas) }] }];
                        }
                    });
                }); });
                return [2 /*return*/];
            });
        });
    };
    return HomeAssistantMCP;
}(McpAgent));
export { HomeAssistantMCP };
