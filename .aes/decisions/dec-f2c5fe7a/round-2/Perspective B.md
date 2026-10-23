## My view: new options and my first pick

**Option E: make the plugin format MCP Apps-compatible.** Don't invent a manifest that only UniView reads. Plugins would be MCP servers that ship sandboxed HTML UI resources. A format plugin built once would then work in , ChatGPT, IDEs and UniView, which solves the developer cold-start problem. UniView competes on being the best host: offline use, file handles, paired devices and mobile.
- **Risks:** the spec is still young and could drift. UniView gives up some control over the format. Monetizing the format itself gets harder.

**Option F: declarative view specs before code.** Agents mostly need to show tables, trees, diffs, timelines and annotated overlays. Let them write a JSON view spec, either a sidecar file or an MCP call, that UniView's trusted renderers draw. No third-party code runs. "Anyone builds anything" becomes safe for most cases, and it works on iOS without breaking guideline 2.5.2 (downloaded executable code). Code plugins become a smaller, signed tier.
- **Risks:** the spec's expressiveness limits what agents can show, and pressure to keep adding view types will grow.

**Option G: the paired desktop does the work for mobile.** Heavy converters run only on the desktop. Phones view the output (PDF, HTML, tiles) over the encrypted LAN link. This gives honest mobile parity with no native code on the phone.

**Option H: zero-daemon handoff.** Agents run `uniview open <file> --view <spec>`, or a URL or share intent. Agents with no MCP setup can use it, and nothing has to run in the background.

**My first pick: F inside E.** Every agent uses declarative views by default, and MCP Apps-compatible code plugins form the signed second tier. This gets agents using UniView right away (Perspective C's wedge) without the security gamble of running arbitrary code. Developers get distribution beyond UniView. G handles mobile. Money comes from enterprise private registries and policy controls, not a store tax.
