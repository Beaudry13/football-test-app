import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MotionLabEditor } from './MotionLabEditor'
import { isEditorKeystroke } from './keyboardScope'
import { createLocalPlayRepository } from '../storage/localPlayRepository'

/**
 * Motion Lab's shortcuts act on the field, and only on the field: typing
 * anywhere else in PEIRA - or into Motion Lab's own text fields - is left
 * alone, and nothing is listening once the editor is gone.
 *
 * B (open the ball menu) is the probe: it needs no selection and its effect
 * is visible.
 */

const ballMenuOpen = () => screen.queryByRole('button', { name: 'QB Keep' }) !== null

beforeEach(() => {
  localStorage.clear()
})

function mountEditor() {
  return render(
    <div className="motion-lab-root">
      <MotionLabEditor repository={createLocalPlayRepository()} />
    </div>,
  )
}

/** A PEIRA control outside the editor, e.g. a portaled dialog's field. */
function outside<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  return el
}

describe('isEditorKeystroke', () => {
  it('accepts the page itself and anything inside the editor', () => {
    const editor = outside('div')
    const inner = document.createElement('button')
    editor.appendChild(inner)
    expect(isEditorKeystroke(document.body, editor)).toBe(true)
    expect(isEditorKeystroke(window, editor)).toBe(true)
    expect(isEditorKeystroke(document, editor)).toBe(true)
    expect(isEditorKeystroke(inner, editor)).toBe(true)
  })

  it('refuses text controls, inside the editor or not', () => {
    const editor = outside('div')
    for (const html of ['<input>', '<textarea></textarea>', '<select></select>', '<div contenteditable="true"><span>x</span></div>']) {
      editor.innerHTML = html
      const target = editor.querySelector('span') ?? editor.firstElementChild!
      expect(isEditorKeystroke(target, editor), html).toBe(false)
    }
  })

  it('treats contenteditable="false" as ordinary content', () => {
    const editor = outside('div')
    editor.innerHTML = '<div contenteditable="false"><b>x</b></div>'
    expect(isEditorKeystroke(editor.querySelector('b'), editor)).toBe(true)
  })

  it('refuses anything outside the editor', () => {
    const editor = outside('div')
    expect(isEditorKeystroke(outside('button'), editor)).toBe(false)
    expect(isEditorKeystroke(null, editor)).toBe(false)
  })
})

describe('the editor\'s shortcuts in PEIRA', () => {
  it('B opens the ball menu from the field', () => {
    mountEditor()
    fireEvent.keyDown(document.body, { key: 'b' })
    expect(ballMenuOpen()).toBe(true)
  })

  it.each([
    ['a PEIRA textarea', () => outside('textarea')],
    ['a PEIRA input', () => outside('input')],
    ['a PEIRA select', () => outside('select')],
    ['a PEIRA rich-text area', () => outside('div', { contenteditable: 'true' })],
    ['a PEIRA button outside the editor', () => outside('button')],
  ])('typing into %s does nothing to Motion Lab', (_label, make) => {
    mountEditor()
    const target = make()
    fireEvent.keyDown(target, { key: 'b' })
    fireEvent.keyDown(target, { key: ' ', code: 'Space' })
    expect(ballMenuOpen()).toBe(false)
  })

  it('typing in Motion Lab\'s own number fields does not trigger shortcuts', () => {
    mountEditor()
    fireEvent.click(document.querySelector('.sit-chip')!)
    const distance = document.querySelector('.sit-pop input[type=number]') as HTMLInputElement
    fireEvent.keyDown(distance, { key: 'b' })
    expect(ballMenuOpen()).toBe(false)
  })

  it('the arrow keys belong to the field, not to a number field', () => {
    // ML-UX-2 gave the arrows to the clock. A coach setting "3rd & 7" uses
    // them to move the caret inside the box, and must keep them.
    mountEditor()
    fireEvent.click(document.querySelector('.sit-chip')!)
    const distance = document.querySelector('.sit-pop input[type=number]') as HTMLInputElement
    const scrub = () => document.querySelector('.scrub input[type=range]') as HTMLInputElement
    const before = scrub().value

    for (const shiftKey of [false, true]) {
      fireEvent.keyDown(distance, { key: 'ArrowLeft', code: 'ArrowLeft', shiftKey })
      fireEvent.keyDown(distance, { key: 'ArrowRight', code: 'ArrowRight', shiftKey })
    }
    fireEvent.keyDown(distance, { key: 'r' })

    expect(scrub().value).toBe(before)
  })

  it('stops listening when the editor is gone', () => {
    const { unmount } = mountEditor()
    unmount()
    expect(() => fireEvent.keyDown(document.body, { key: 'b' })).not.toThrow()
    expect(ballMenuOpen()).toBe(false)
  })
})
