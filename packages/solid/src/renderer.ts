import { createRenderer } from 'solid-js/universal'
import {
  asNode,
  createElement,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProperty,
  type SolidNode,
} from './nodes.ts'

export const renderer = createRenderer<SolidNode>({
  createElement,
  createTextNode,
  isTextNode: (node) => asNode(node).kind === 'text-node',
  replaceText: (node, value) => replaceText(asNode(node), value),
  setProperty: (node, name, value) => setProperty(asNode(node), name, value),
  insertNode: (parent, node, anchor) =>
    insertNode(asNode(parent), asNode(node), anchor === undefined ? undefined : asNode(anchor)),
  removeNode: (parent, node) => removeNode(asNode(parent), asNode(node)),
  getParentNode: (node) => asNode(node).parent,
  getFirstChild: (node) => asNode(node).children[0],
  getNextSibling: (value) => {
    const node = asNode(value)
    return node.parent?.children[node.parent.children.indexOf(node) + 1]
  },
})
