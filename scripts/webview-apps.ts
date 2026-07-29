export const WEBVIEW_APPS = {
  rakuten: {
    packageName: "com.ebates",
  },
  ibotta: {
    packageName: "com.ibotta.android",
  },
} as const;

export type WebViewAppName = keyof typeof WEBVIEW_APPS;
