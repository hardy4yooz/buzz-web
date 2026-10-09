import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocale, t } from "@/shared/i18n";

afterEach(() => vi.unstubAllGlobals());

describe("resolveLocale", () => {
  it("uses Chinese when the preferred browser language is Chinese", () => {
    expect(resolveLocale(["zh-Hans-CN", "en-US"])).toBe("zh-CN");
  });

  it("uses English when it is preferred, even with Chinese as a fallback", () => {
    expect(resolveLocale(["en-US", "zh-CN"])).toBe("en");
  });

  it("localizes the image preparation error in English and Chinese", () => {
    vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
    expect(t("error.attachmentImagePrepare")).toBe("We couldn't prepare this image for upload.");
    vi.stubGlobal("navigator", { language: "zh-CN", languages: ["zh-CN"] });
    expect(t("error.attachmentImagePrepare")).toBe("无法处理此图片以上传。");
  });

  it("localizes the agent activity panel in English and Chinese", () => {
    vi.stubGlobal("navigator", { language: "en-US", languages: ["en-US"] });
    expect(t("activity.panelTitle")).toBe("Agent activity");
    vi.stubGlobal("navigator", { language: "zh-CN", languages: ["zh-CN"] });
    expect(t("activity.panelTitle")).toBe("Agent 活动");
    expect(t("activity.view")).toBe("查看活动");
  });
});
