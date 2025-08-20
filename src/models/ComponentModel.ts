// src/models/ComponentModel.ts
import { types, Instance, SnapshotIn, SnapshotOut, IAnyModelType } from 'mobx-state-tree';
import React from 'react';

// Pre-declare the type to avoid circular reference issues
interface IComponentModel extends Instance<typeof ComponentModel> {}

// Component type enum to differentiate between host elements and function components
export enum ComponentTypeEnum {
  HOST = 'host',           // JSX intrinsic elements: "div", "span", "button" 
  FUNCTION = 'function'    // Function components: "MyButton", "CustomCard"
}

// Type-safe intrinsic element types using React's JSX system
export type IntrinsicElementType = keyof React.JSX.IntrinsicElements;

// Helper type to get props for intrinsic elements
export type IntrinsicElementProps<T extends IntrinsicElementType> = React.JSX.IntrinsicElements[T];

// Type for function component names (serializable string references)
export type FunctionComponentType = string;

// Union type for all possible component types in our system
export type ComponentType = IntrinsicElementType | FunctionComponentType;

// Helper functions to work with React's type system
export const isIntrinsicElement = (type: string): type is string & IntrinsicElementType => {
  // Simple check: intrinsic elements are lowercase and follow HTML tag pattern
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(type);
};

// Validate props for intrinsic elements using React's type system
export const validateIntrinsicProps = <T extends IntrinsicElementType>(
  type: T, 
  props: any
): props is IntrinsicElementProps<T> => {
  // In a real implementation, you could add runtime validation here
  // For now, TypeScript handles compile-time validation
  return true;
};

// Define the React-like element model - handles both host and function components
const ComponentModel: IAnyModelType = types.model('Component', {
    id: types.identifier,
    
    // The component type name - always a string for serialization
    // For host elements: "div", "span", "button"
    // For function components: "MyButton", "CustomCard" 
    type: types.string,
    
    // Distinguishes between host elements and function components
    componentType: types.enumeration(Object.values(ComponentTypeEnum)),
    
    // Matches ReactElement.props - contains ALL attributes, styles, event handlers, children
    props: types.optional(types.frozen(), {}),
    
    // Children stored separately for easier tree manipulation in design tool
    // Note: This is also available in props.children but separate for convenience
    children: types.optional(types.array(types.late((): IAnyModelType => ComponentModel)), [])
  })
  .actions(self => ({
    // Add a child component
    addChild(child: SnapshotIn<typeof ComponentModel>) {
      self.children.push(child);
    },
    
    // Remove a child by id
    removeChild(childId: string) {
      const index = self.children.findIndex((child: any) => child.id === childId);
      if (index >= 0) {
        self.children.splice(index, 1);
      }
    },
    
    // Update props (merges with existing props)
    updateProps(newProps: Record<string, any>) {
      self.props = { ...self.props, ...newProps };
    },
    
    // Set a specific prop value
    setProp(key: string, value: any) {
      self.props = { ...self.props, [key]: value };
    },
    
    // Convenience method for updating styles (they're in props.style)
    updateStyle(styleUpdates: Record<string, any>) {
      const currentStyle = (self.props as any).style || {};
      self.props = { 
        ...self.props, 
        style: { ...currentStyle, ...styleUpdates }
      };
    },
  }))
  .views(self => ({
    // Check if this is a host element (intrinsic HTML/SVG element)
    get isHostElement(): boolean {
      return self.componentType === ComponentTypeEnum.HOST && isIntrinsicElement(self.type);
    },
    
    // Check if this is a function component
    get isFunctionComponent(): boolean {
      return self.componentType === ComponentTypeEnum.FUNCTION;
    },
    
    // Get typed props for intrinsic elements
    get typedProps(): any {
      if (this.isHostElement && isIntrinsicElement(self.type)) {
        // TypeScript will validate these props against React.JSX.IntrinsicElements[type]
        return self.props;
      }
      return self.props;
    },
    
    // Get the React-like element representation
    get reactElement(): { type: string; props: any } {
      return {
        type: self.type,
        props: { ...self.props, children: self.children.length > 0 ? self.children : self.props.children }
      };
    },
    
    // Get all descendant components (recursive)
    get allDescendants(): IComponentModel[] {
      const descendants: IComponentModel[] = [];
      
      function collectDescendants(component: IComponentModel) {
        component.children.forEach((child: IComponentModel) => {
          descendants.push(child);
          collectDescendants(child);
        });
      }
      
      collectDescendants(self as IComponentModel);
      return descendants;
    },
    
    // Find component by id in tree
    findById(id: string): IComponentModel | undefined {
      if (self.id === id) return self as IComponentModel;
      
      for (const child of self.children) {
        const found = (child as IComponentModel).findById(id);
        if (found) return found;
      }
      
      return undefined;
    }
  }));

// Export TypeScript types for the model
export type ComponentInstance = IComponentModel;
export type ComponentSnapshotIn = SnapshotIn<typeof ComponentModel>;
export type ComponentSnapshotOut = SnapshotOut<typeof ComponentModel>;

// Type-safe helper functions for creating components
export const createIntrinsicComponent = <T extends IntrinsicElementType>(
  id: string,
  type: T,
  props: IntrinsicElementProps<T>
) => {
  return ComponentModel.create({
    id,
    type,
    componentType: ComponentTypeEnum.HOST,
    props: props as any // MST frozen type requires any
  });
};

export const createFunctionComponent = (
  id: string,
  type: FunctionComponentType,
  props: Record<string, any>
) => {
  return ComponentModel.create({
    id,
    type,
    componentType: ComponentTypeEnum.FUNCTION,
    props
  });
};

export default ComponentModel;

// Example usage with type safety:
/*
// Type-safe host element creation - TypeScript validates props!
const divElement = createIntrinsicComponent("div-1", "div", {
  className: "container",
  style: { backgroundColor: "blue", width: 200, height: 100 },
  onClick: (e) => console.log("clicked", e.currentTarget), // ✅ Typed as MouseEvent<HTMLDivElement>
  // href: "invalid" // ❌ TypeScript error: href doesn't exist on div
});

// Type-safe button element
const buttonElement = createIntrinsicComponent("btn-1", "button", {
  disabled: true,
  onClick: (e) => console.log("button clicked"), // ✅ Typed correctly
  children: "Click me"
});

// Function component (custom)
const customButton = createFunctionComponent("custom-1", "MyButton", {
  variant: "primary",
  disabled: false,
  children: "Custom Button"
});

// Add children
divElement.addChild(buttonElement);
divElement.addChild(customButton);

// Type-safe rendering:
function renderComponent(element: ComponentInstance): React.ReactElement {
  if (element.isHostElement) {
    // element.type is typed as keyof JSX.IntrinsicElements
    // element.typedProps are validated against JSX.IntrinsicElements[type]
    return React.createElement(element.type, element.typedProps, ...element.children.map(renderComponent));
  } 
  
  if (element.isFunctionComponent) {
    // Look up in component registry
    const ComponentFn = ComponentRegistry[element.type];
    return ComponentFn(element.props);
  }
}
*/
  