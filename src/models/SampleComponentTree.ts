// src/models/SampleComponentTree.ts
import { RootStore } from '@/stores/RootStore';
import { 
  createIntrinsicComponent, 
  createFunctionComponent,
  ComponentInstance
} from './ComponentModel';

// Create a sample component tree for testing
export const createSampleTree = (): ComponentInstance => {

  // Root container (div)
  const rootContainer = createIntrinsicComponent("root", "div", {
    className: "app-container",
    style: {
      width: "100%",
      height: "100vh",
      backgroundColor: "#f5f5f5",
      padding: "20px",
      fontFamily: "Arial, sans-serif"
    }
  });

  // Header section
  const header = createIntrinsicComponent("header", "header", {
    className: "app-header",
    style: {
      backgroundColor: "#2563eb",
      color: "white",
      padding: "16px",
      borderRadius: "8px",
      marginBottom: "20px"
    }
  });

  // Title (h1)
  const title = createIntrinsicComponent("title", "h1", {
    style: {
      margin: { "desktop": "0", "tablet": "0", "mobile": "0" },
      fontSize: "24px",
      fontWeight: "bold"
    },
    children: "Framer Clone - Component Tree Test"
  });

  // Subtitle (p)
  const subtitle = createIntrinsicComponent("subtitle", "p", {
    style: {
      margin: "8px 0 0 0",
      fontSize: "14px",
      opacity: 0.9
    },
    children: "Testing our React-compatible ComponentModel"
  });

  // Main content area
  const mainContent = createIntrinsicComponent("main", "main", {
    className: "main-content",
    style: {
      display: "flex",
      gap: "20px",
      flexWrap: "wrap"
    }
  });

  // Card component (function component)
  const card1 = createFunctionComponent("card-1", "Card", {
    title: "Feature 1",
    description: "This is a custom Card component",
    variant: "primary",
    onClick: () => console.log("Card 1 clicked")
  });

  const card2 = createFunctionComponent("card-2", "Card", {
    title: "Feature 2", 
    description: "Another Card with different props",
    variant: "secondary",
    disabled: true
  });

  // Button section
  const buttonSection = createIntrinsicComponent("button-section", "div", {
    style: {
      display: "flex",
      gap: "12px",
      marginTop: "20px"
    }
  });

  // Native HTML button
  const htmlButton = createIntrinsicComponent("html-btn", "button", {
    type: "button",
    disabled: false,
    onClick: (e) => {
      console.log("HTML button clicked!", e.currentTarget);
    },
    style: {
      padding: "8px 16px",
      backgroundColor: "#10b981",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer"
    },
    children: "Native Button"
  });

  // Custom button component
  const customButton = createFunctionComponent("custom-btn", "Button", {
    variant: "danger",
    size: "large",
    style: {
      backgroundColor: "red",
      padding: "8px 16px",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer"
    },
    onClick: () => console.log("Custom button clicked!"),
    children: "Custom Button"
  });

  // Form section with inputs
  const formSection = createIntrinsicComponent("form", "form", {
    onSubmit: (e) => {
      e.preventDefault();
      console.log("Form submitted!");
    },
    style: {
      backgroundColor: "white",
      padding: "20px",
      borderRadius: "8px",
      boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
      marginTop: "20px"
    }
  });

  const inputLabel = createIntrinsicComponent("input-label", "label", {
    htmlFor: "sample-input",
    style: {
      display: "block",
      marginBottom: "8px",
      fontWeight: "bold"
    },
    children: "Sample Input:"
  });

  const textInput = createIntrinsicComponent("text-input", "input", {
    type: "text",
    id: "sample-input",
    placeholder: "Enter some text...",
    onChange: (e) => console.log("Input changed:", e.currentTarget.value),
    style: {
      width: "100%",
      padding: "8px",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      fontSize: "14px"
    }
  });

  const submitButton = createIntrinsicComponent("submit-btn", "button", {
    type: "submit",
    style: {
      marginTop: "12px",
      padding: "8px 16px",
      backgroundColor: "#3b82f6",
      color: "white",
      border: "none",
      borderRadius: "4px",
      cursor: "pointer"
    },
    children: "Submit"
  });

  // Build the tree structure
  // Add elements to header
  header.addChild(title);
  header.addChild(subtitle);

  // Add cards to main content
  mainContent.addChild(card1);
  mainContent.addChild(card2);

  // Add buttons to button section
  buttonSection.addChild(htmlButton);
  buttonSection.addChild(customButton);

  // Add form elements
  formSection.addChild(inputLabel);
  formSection.addChild(textInput);
  formSection.addChild(submitButton);

  // Add all sections to root
  rootContainer.addChild(header);
  rootContainer.addChild(mainContent);
  rootContainer.addChild(buttonSection);
  rootContainer.addChild(formSection);

  return rootContainer;
};

// Create the sample tree
export const sampleComponentTree = createSampleTree(RootStore);

// Helper function to print tree structure
export const printTreeStructure = (component: ComponentInstance, indent = 0): void => {
  const spaces = "  ".repeat(indent);
  const typeInfo = component.isHostElement ? "HOST" : "FUNCTION";
  
  console.log(`${spaces}${component.type} (${typeInfo}) - id: ${component.id}`);
  
  if (component.props && Object.keys(component.props).length > 0) {
    const propKeys = Object.keys(component.props).filter(key => key !== 'children');
    if (propKeys.length > 0) {
      console.log(`${spaces}  props: [${propKeys.join(', ')}]`);
    }
  }
  
  component.children.forEach((child: ComponentInstance) => {
    printTreeStructure(child, indent + 1);
  });
};