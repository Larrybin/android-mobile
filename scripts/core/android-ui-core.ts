import { XMLParser } from "fast-xml-parser";

import { CashbackError } from "./errors.js";

export interface UiBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface UiNode {
  text?: string;
  resourceId?: string;
  contentDescription?: string;
  className?: string;
  clickable: boolean;
  bounds: UiBounds;
}

export interface UiSelector {
  resourceId?: string;
  contentDescription?: string;
  text?: string;
  className?: string;
  clickable?: boolean;
}

interface XmlNode {
  text?: string;
  "resource-id"?: string;
  "content-desc"?: string;
  class?: string;
  clickable?: string;
  bounds?: string;
  node?: XmlNode | XmlNode[];
}

function optionalString(value?: string): string | undefined {
  return value || undefined;
}

function parseBounds(value?: string): UiBounds {
  if (value === undefined) {
    throw new CashbackError("UI_XML_INVALID", "ui", "UI node has no bounds");
  }
  const match = value.match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) {
    throw new CashbackError(
      "UI_XML_INVALID",
      "ui",
      `invalid UI bounds ${value}`,
    );
  }
  return {
    left: Number(match[1]),
    top: Number(match[2]),
    right: Number(match[3]),
    bottom: Number(match[4]),
  };
}

function appendNode(input: XmlNode, output: UiNode[]): void {
  output.push({
    text: optionalString(input.text),
    resourceId: optionalString(input["resource-id"]),
    contentDescription: optionalString(input["content-desc"]),
    className: optionalString(input.class),
    clickable: input.clickable === "true",
    bounds: parseBounds(input.bounds),
  });

  const children = input.node
    ? Array.isArray(input.node)
      ? input.node
      : [input.node]
    : [];
  for (const child of children) {
    appendNode(child, output);
  }
}

export function parseUiHierarchy(xml: string): UiNode[] {
  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseAttributeValue: false,
    }).parse(xml);
  } catch (error) {
    throw new CashbackError("UI_XML_INVALID", "ui", "invalid UI XML", {
      cause: error,
    });
  }

  const hierarchy = (
    parsed as { hierarchy?: { node?: XmlNode | XmlNode[] } }
  ).hierarchy;
  const roots = hierarchy?.node
    ? Array.isArray(hierarchy.node)
      ? hierarchy.node
      : [hierarchy.node]
    : [];
  if (roots.length === 0) {
    throw new CashbackError(
      "UI_XML_INVALID",
      "ui",
      "UI hierarchy has no nodes",
    );
  }

  const nodes: UiNode[] = [];
  for (const root of roots) {
    appendNode(root, nodes);
  }
  return nodes;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function matchesSelector(node: UiNode, selector: UiSelector): boolean {
  return (
    (selector.resourceId === undefined ||
      node.resourceId === selector.resourceId) &&
    (selector.contentDescription === undefined ||
      node.contentDescription === selector.contentDescription) &&
    (selector.text === undefined ||
      (node.text !== undefined &&
        normalizeText(node.text) === normalizeText(selector.text))) &&
    (selector.className === undefined ||
      node.className === selector.className) &&
    (selector.clickable === undefined ||
      node.clickable === selector.clickable)
  );
}

export function selectFirstNode(
  nodes: UiNode[],
  selectors: readonly UiSelector[],
): UiNode | undefined {
  for (const selector of selectors) {
    const node = nodes.find((candidate) =>
      matchesSelector(candidate, selector),
    );
    if (node) {
      return node;
    }
  }
  return undefined;
}

export function findUniqueExactText(
  nodes: UiNode[],
  value: string,
): UiNode {
  const expected = normalizeText(value);
  const matches = nodes.filter(
    (node) =>
      node.className !== "android.widget.EditText" &&
      node.text &&
      normalizeText(node.text) === expected,
  );
  if (matches.length === 0) {
    throw new CashbackError(
      "MERCHANT_NOT_FOUND",
      "ui",
      `no exact UI match for ${value}`,
    );
  }
  if (matches.length > 1) {
    throw new CashbackError(
      "MERCHANT_AMBIGUOUS",
      "ui",
      `multiple exact UI matches for ${value}`,
    );
  }
  return matches[0]!;
}

export function findNearestMatchingText(
  nodes: UiNode[],
  anchor: UiNode,
  pattern: RegExp,
): UiNode {
  const candidates = nodes
    .filter((node) => node.text !== undefined && pattern.test(node.text))
    .map((node) => {
      const anchorCenter = nodeCenter(anchor);
      const nodePosition = nodeCenter(node);
      return {
        node,
        distance:
          (nodePosition.x - anchorCenter.x) ** 2 +
          (nodePosition.y - anchorCenter.y) ** 2,
      };
    })
    .sort((left, right) => left.distance - right.distance);

  if (candidates.length === 0) {
    throw new CashbackError(
      "CASHBACK_NOT_FOUND",
      "ui",
      "no cashback text was found near the selected merchant",
    );
  }
  if (
    candidates.length > 1 &&
    candidates[0]!.distance === candidates[1]!.distance
  ) {
    throw new CashbackError(
      "CASHBACK_AMBIGUOUS",
      "ui",
      "multiple cashback values were equally close to the selected merchant",
    );
  }
  return candidates[0]!.node;
}

export function nodeCenter(node: UiNode): { x: number; y: number } {
  return {
    x: Math.round((node.bounds.left + node.bounds.right) / 2),
    y: Math.round((node.bounds.top + node.bounds.bottom) / 2),
  };
}
