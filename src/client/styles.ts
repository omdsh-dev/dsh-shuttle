export const SHUTTLE_STYLES = String.raw`
.dsh-shuttle { width: 100%; max-width: 760px; color: var(--dsw-alias-label-primary); }
.dsh-shuttle * { box-sizing: border-box; }
.dsh-shuttle-section { display: flex; flex-direction: column; gap: 14px; }
.dsh-shuttle-section__header { display: flex; flex-direction: column; gap: 6px; }
.dsh-shuttle-section__header h2 { margin: 0; color: var(--dsw-alias-label-primary); font-size: 18px; font-weight: 600; }
.dsh-shuttle-section__header p { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 20px; }
.dsh-shuttle__units { display: grid; gap: 14px; }
.dsh-shuttle-unit { display: flex; min-width: 0; flex-direction: column; gap: 16px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 11px; padding: 15px; background: var(--dsw-alias-bg-layer-3); }
.dsh-shuttle-unit__header { display: flex; align-items: flex-start; gap: 10px; }
.dsh-shuttle-unit__index { display: grid; width: 25px; height: 25px; flex: none; place-items: center; border-radius: 7px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent); color: var(--dsw-alias-state-business-primary); font-size: 12px; font-weight: 700; }
.dsh-shuttle-unit__header h3 { margin: 1px 0 3px; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 20px; }
.dsh-shuttle-unit__header p { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
.dsh-shuttle__form { display: flex; flex-direction: column; gap: 16px; }
.dsh-shuttle__direction { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 0; border: 0; border-radius: 9px; padding: 4px; background: var(--dsw-alias-bg-layer-1); }
.dsh-shuttle__direction legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.dsh-shuttle__direction button { min-height: 34px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; font-weight: 550; cursor: pointer; }
.dsh-shuttle__direction button:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-shuttle__direction button[aria-pressed='true'] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv1); }
.dsh-shuttle__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.dsh-shuttle__field { display: flex; min-width: 0; flex-direction: column; gap: 6px; }
.dsh-shuttle__field--wide { grid-column: 1 / -1; }
.dsh-shuttle__field > span, .dsh-shuttle__scope legend { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; font-weight: 600; }
.dsh-shuttle__field input, .dsh-shuttle__field select { width: 100%; height: 38px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 0 11px; outline: 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.dsh-shuttle__field input::placeholder { color: var(--dsw-alias-label-tertiary); }
.dsh-shuttle__field input:focus-visible, .dsh-shuttle__field select:focus-visible, .dsh-shuttle button:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 42%, transparent); outline-offset: 1px; }
.dsh-shuttle__field small { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 17px; }
.dsh-shuttle__scope { display: flex; flex-direction: column; gap: 7px; margin: 0; border: 0; padding: 0; }
.dsh-shuttle__scope-options { display: flex; min-height: 38px; align-items: center; gap: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 0 11px; background: var(--dsw-alias-bg-layer-1); }
.dsh-shuttle__scope label { display: inline-flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary); font-size: 13px; cursor: pointer; }
.dsh-shuttle__scope input { accent-color: var(--dsw-alias-state-business-primary); }
.dsh-shuttle__validation { margin: -7px 0 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.dsh-shuttle__actions { display: flex; align-items: center; gap: 10px; padding-top: 2px; }
.dsh-shuttle__button { min-height: 36px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 0 15px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.dsh-shuttle__button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-shuttle__button--primary { border-color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-primary); color: white; }
.dsh-shuttle__button--primary:hover:not(:disabled) { filter: brightness(1.05); background: var(--dsw-alias-state-business-primary); }
.dsh-shuttle__button:disabled { opacity: .48; cursor: not-allowed; }
.dsh-shuttle__result { overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; background: var(--dsw-alias-bg-module-platform); }
.dsh-shuttle__result[data-kind='error'] { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 42%, var(--dsw-alias-border-l2)); }
.dsh-shuttle__result-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); padding: 10px 13px; }
.dsh-shuttle__result-header strong { font-size: 12px; }
.dsh-shuttle__badge { border-radius: 999px; padding: 2px 7px; background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.dsh-shuttle__result[data-kind='error'] .dsh-shuttle__badge { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
.dsh-shuttle__result pre { max-height: 280px; overflow: auto; margin: 0; padding: 13px; color: var(--dsw-alias-label-secondary); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-shuttle__confirm { display: flex; flex-direction: column; gap: 11px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 30%, var(--dsw-alias-border-l2)); border-radius: 10px; padding: 13px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 5%, transparent); }
.dsh-shuttle__confirm p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.dsh-shuttle__confirm label { display: flex; align-items: flex-start; gap: 8px; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; cursor: pointer; }
.dsh-shuttle__confirm input { margin-top: 2px; accent-color: var(--dsw-alias-state-business-primary); }
@media (max-width: 680px) { .dsh-shuttle__grid { grid-template-columns: minmax(0, 1fr); } .dsh-shuttle__field--wide { grid-column: auto; } }
`
