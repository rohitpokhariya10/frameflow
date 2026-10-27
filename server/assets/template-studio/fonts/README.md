# Template Studio fonts

Fonts the Template Studio renderer (`server/src/templateStudio/compose/text.ts`) uses to draw campaign copy exactly; the
art director chooses among them (`server/src/templateStudio/fonts/catalog.ts`). Taken from the Generator (Poster Studio)
archive, which took them from Google Fonts.

**Licence.** Every family here is under the SIL Open Font License 1.1; each folder keeps its `OFL.txt` with the
copyright notice. They are bundled with this software and are never sold on their own.

**Modified versions.** Some families are static weights instanced from the published variable fonts and some have their
GSUB table removed so opentype.js can read them (Bricolage Grotesque, Lexend, Manrope, Outfit, Plus Jakarta Sans,
Rubik, Sora, Syne, Teko, Urbanist). OFL 1.1 allows modified versions under the same licence, provided they do not use a
Reserved Font Name. None of these modified files uses one: nine of the ten families declare none, and Lexend's
declared Reserved Font Name is "RevReading Lexend", which the files here do not use (they are named "Lexend").

**Reserved Font Names.** Five other families declare one and are bundled unmodified: Abril Fatface, Lilita One and
Titan One (byte-identical to the Generator archive's copies), Righteous (byte-identical to the official Google Fonts
file, checked 2026-10-12) and DM Serif Display (whose declared name, "Source", the files do not use either). The
remaining families declare none.

To add a family, put one static `.ttf` per weight and its `OFL.txt` in a folder here and add it to the catalogue; if a
Reserved Font Name is declared, use the unmodified file or rename a modified one.
