// src/test-component-tree.ts
// Simple test file to verify our ComponentModel works

import { sampleComponentTree, printTreeStructure } from './models/SampleComponentTree';

console.log("🚀 Testing ComponentModel with Sample Tree");
console.log("==========================================\n");

// Test 1: Print tree structure
console.log("📊 Tree Structure:");
printTreeStructure(sampleComponentTree);

console.log("\n" + "=".repeat(50));

// Test 2: Test type checking
console.log("\n🔍 Type Checking Tests:");
console.log("Root is host element:", sampleComponentTree.isHostElement);
console.log("Root is function component:", sampleComponentTree.isFunctionComponent);
console.log("Root type:", sampleComponentTree.type);

// Find a function component
const card = sampleComponentTree.findById("card-1");
if (card) {
  console.log("Card is host element:", card.isHostElement);
  console.log("Card is function component:", card.isFunctionComponent);
  console.log("Card type:", card.type);
}

console.log("\n" + "=".repeat(50));

// Test 3: Test reactElement getter
console.log("\n⚛️  React Element Structure:");
const reactEl = sampleComponentTree.reactElement;
console.log("Type:", reactEl.type);
console.log("Props keys:", Object.keys(reactEl.props));

console.log("\n" + "=".repeat(50));

// Test 4: Test component manipulation
console.log("\n🛠️  Component Manipulation:");
console.log("Initial children count:", sampleComponentTree.children.length);

// Add a new component
import { createIntrinsicComponent } from './models/ComponentModel';

const newDiv = createIntrinsicComponent("test-div", "div", {
  className: "test-element",
  style: { backgroundColor: "yellow" },
  children: "Dynamically added!"
});

sampleComponentTree.addChild(newDiv);
console.log("After adding child:", sampleComponentTree.children.length);

// Test prop updates
newDiv.updateProps({ 
  style: { backgroundColor: "green", color: "white" },
  "data-testid": "dynamic-element"
});

console.log("Updated props:", Object.keys(newDiv.props));

console.log("\n" + "=".repeat(50));

// Test 5: Serialization
console.log("\n💾 Serialization Test:");
try {
  const serialized = JSON.stringify(sampleComponentTree);
  console.log("✅ Serialization successful! Size:", serialized.length, "characters");
  
  // Test deserialization
  const parsed = JSON.parse(serialized);
  console.log("✅ Deserialization successful! Root type:", parsed.type);
} catch (error) {
  console.error("❌ Serialization failed:", error);
}

console.log("\n🎉 All tests completed!");
