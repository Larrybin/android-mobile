import assert from "node:assert/strict";
import test from "node:test";

import {
  findNearestMatchingText,
  findUniqueExactText,
  nodeCenter,
  parseUiHierarchy,
  selectFirstNode,
} from "../scripts/core/android-ui-core.js";

const hierarchy = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="com.ebates:id/root" class="android.view.View" bounds="[0,0][1080,2200]">
    <node index="0" text="Search" content-desc="Merchant search" resource-id="com.ebates:id/search" class="android.widget.Button" clickable="true" bounds="[20,40][220,140]" />
    <node index="1" text="Nike" resource-id="com.ebates:id/merchant_name" class="android.widget.TextView" bounds="[30,300][300,380]" />
    <node index="2" text="10% Cash Back" resource-id="com.ebates:id/rate" class="android.widget.TextView" bounds="[30,390][400,450]" />
  </node>
</hierarchy>`;

test("parseUiHierarchy flattens nodes and preserves accessibility evidence", () => {
  const nodes = parseUiHierarchy(hierarchy);
  assert.equal(nodes.length, 4);
  assert.deepEqual(nodes[1], {
    text: "Search",
    resourceId: "com.ebates:id/search",
    contentDescription: "Merchant search",
    className: "android.widget.Button",
    clickable: true,
    bounds: { left: 20, top: 40, right: 220, bottom: 140 },
  });
});

test("selector priority uses resource id before content description and text", () => {
  const nodes = parseUiHierarchy(hierarchy);
  assert.equal(
    selectFirstNode(nodes, [
      { resourceId: "com.ebates:id/search" },
      { text: "Search" },
    ])?.resourceId,
    "com.ebates:id/search",
  );
});

test("findUniqueExactText normalizes case and rejects ambiguous merchants", () => {
  const nodes = parseUiHierarchy(hierarchy);
  assert.equal(findUniqueExactText(nodes, " nike ")?.text, "Nike");
  assert.equal(
    findUniqueExactText(
      [
        ...nodes,
        {
          ...nodes[2]!,
          className: "android.widget.EditText",
        },
      ],
      "Nike",
    )?.resourceId,
    "com.ebates:id/merchant_name",
  );
  assert.throws(
    () => findUniqueExactText([...nodes, nodes[2]!], "Nike"),
    /multiple exact UI matches/,
  );
  assert.throws(
    () => findUniqueExactText(nodes, "Adidas"),
    /no exact UI match/,
  );
});

test("nodeCenter derives taps from accessibility bounds", () => {
  const node = findUniqueExactText(parseUiHierarchy(hierarchy), "Nike");
  assert.deepEqual(nodeCenter(node), { x: 165, y: 340 });
});

test("parseUiHierarchy rejects missing roots and invalid bounds", () => {
  assert.throws(
    () => parseUiHierarchy(null as unknown as string),
    /invalid UI XML/,
  );
  assert.throws(() => parseUiHierarchy("<hierarchy />"), /has no nodes/);
  assert.throws(
    () => parseUiHierarchy('<hierarchy><node bounds="bad" /></hierarchy>'),
    /invalid UI bounds/,
  );
  assert.throws(
    () => parseUiHierarchy('<hierarchy><node text="x" /></hierarchy>'),
    /has no bounds/,
  );
});

test("parseUiHierarchy supports multiple roots and optional attributes", () => {
  const nodes = parseUiHierarchy(
    [
      "<hierarchy>",
      '<node clickable="false" bounds="[0,0][1,1]" />',
      '<node clickable="true" bounds="[1,1][2,2]">',
      '<node text="Child" bounds="[1,1][2,2]" />',
      "</node>",
      "</hierarchy>",
    ].join(""),
  );
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0]?.text, undefined);
  assert.equal(nodes[1]?.clickable, true);
  assert.equal(nodes[2]?.text, "Child");
});

test("selectFirstNode applies every selector field and may return no match", () => {
  const nodes = parseUiHierarchy(
    '<hierarchy><node text="Nike" resource-id="merchant" content-desc="Store" class="android.widget.TextView" bounds="[0,0][1,1]" /></hierarchy>',
  );
  assert.equal(
    selectFirstNode(nodes, [
      { resourceId: "wrong" },
      {
        resourceId: "merchant",
        contentDescription: "Store",
        text: "Nike",
        className: "android.widget.TextView",
        clickable: false,
      },
    ])?.text,
    "Nike",
  );
  assert.equal(
    selectFirstNode(nodes, [{ contentDescription: "Wrong" }]),
    undefined,
  );
  assert.equal(selectFirstNode(nodes, [{ text: "Wrong" }]), undefined);
});

test("findNearestMatchingText binds cashback to the selected merchant", () => {
  const nodes = parseUiHierarchy(
    [
      "<hierarchy>",
      '<node text="Nike" bounds="[300,500][450,560]" />',
      '<node text="8% Cash Back was 2%" bounds="[300,600][700,660]" />',
      '<node text="16% Cash Back was 2%" bounds="[300,1500][700,1560]" />',
      "</hierarchy>",
    ].join(""),
  );
  assert.equal(
    findNearestMatchingText(
      nodes,
      findUniqueExactText(nodes, "Nike"),
      /\d+% Cash Back/,
    ).text,
    "8% Cash Back was 2%",
  );
  assert.throws(
    () => findNearestMatchingText(nodes, nodes[0]!, /missing/),
    /no cashback text/,
  );
  assert.throws(
    () =>
      findNearestMatchingText(
        [
          {
            text: "Nike",
            clickable: false,
            bounds: { left: 50, top: 50, right: 60, bottom: 60 },
          },
          {
            text: "8% Cash Back",
            clickable: false,
            bounds: { left: 30, top: 50, right: 40, bottom: 60 },
          },
          {
            text: "10% Cash Back",
            clickable: false,
            bounds: { left: 70, top: 50, right: 80, bottom: 60 },
          },
        ],
        {
          text: "Nike",
          clickable: false,
          bounds: { left: 50, top: 50, right: 60, bottom: 60 },
        },
        /Cash Back/,
      ),
    /equally close/,
  );
});
