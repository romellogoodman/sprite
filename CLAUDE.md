# Project Guidelines

This is a React.js app with SCSS styles.

## File Structure

- All React components should be placed in `src/App.jsx`
- All styles should be placed in `src/App.scss`

This single-file approach is intentional for rapid prototyping. Refactor into multiple files as the prototype grows.

## CSS/SCSS Conventions

- Use BEM (Block Element Modifier) naming: `.block__element--modifier`
- Use SCSS nesting with `&` for organization
- Use the CSS custom properties defined at the top of `src/App.scss` for colors, spacing, and typography — do not hardcode values

```scss
.card {
  padding: var(--spacing-2x);

  &__title {
    font-size: var(--font-size-xl);

    &--large { font-size: calc(var(--font-size-xl) * 1.5); }
  }
}
```

## Environment Variables

- Copy `.env.example` to `.env.local` for local configuration
- All Vite environment variables must be prefixed with `VITE_`
- Access in code via `import.meta.env.VITE_*`
