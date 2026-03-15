// Minimal type stub for node-html-parser.
// Full types from package dist/index.d.ts are not available in this environment.
declare module "node-html-parser" {
  interface HTMLElement {
    childNodes: HTMLElement[];
    parentNode: HTMLElement | null;
    innerText: string;
    innerHTML: string;
    outerHTML: string;
    textContent: string | null;
    text: string;
    classNames: string;
    getAttribute(name: string): string | undefined;
    setAttribute(name: string, value: string): void;
    querySelector(selector: string): HTMLElement | null;
    querySelectorAll(selector: string): HTMLElement[];
    find(predicate: (node: HTMLElement) => boolean): HTMLElement | undefined;
    indexOf(item: HTMLElement): number;
  }

  function parse(html: string, options?: Record<string, unknown>): HTMLElement;
}
