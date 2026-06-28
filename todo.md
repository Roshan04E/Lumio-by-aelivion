Beautiful. That means we now have a trustworthy preview/export loop. Big milestone.

**Next Best Todo**
Build **viewer element controls**.

Right now users can place text/shape through inspector values, but normal users expect Canva-style direct manipulation:

- click text/shape in viewer
- drag to move
- resize with corner handles
- rotate with handle
- see inspector update live
- selected element stays synced with timeline selection

This is the right next step because now the viewer is trustworthy, so editing directly inside it becomes valuable.

**Recommended Order**
1. Viewer drag to move text/shape  
Click element, drag it around the preview, update `transform.position.x/y`.

2. Viewer selection polish  
Selected layer should show a clear bounding box and handles.

3. Resize controls  
Corner handles update layer scale first. Later we add real text box width/height.

4. Shape dimensions  
Add actual `width` and `height` properties instead of fixed `44% / 18%`.

5. Text box dimensions  
Add text box width, alignment, stroke, shadow controls.

6. Font system  
Proper font picker and render-safe font loading.

7. Effects controls  
Glow, blur, shadow, background cutout, person cutout.

My vote: implement **viewer drag-to-move + selection handles** next. It will make the editor immediately feel less like a form and more like a real creative tool.


