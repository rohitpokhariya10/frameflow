import type { DesignAspectRatio, NormalizedLayout } from './schema.js';
import type { PremiumLayout } from './themeSpec.js';
export const premiumBox = (x:number,y:number,width:number,height:number):NormalizedLayout=>({x,y,width,height,rotation:0});
type Boxes=Record<string,NormalizedLayout>;
const b=premiumBox;
/** Authored from a canonical family, never from the previous ratio. Photo boxes use contain/cover, never stretching. */
export function premiumLayout(family:PremiumLayout,ratio:DesignAspectRatio):Boxes {
  const wide=ratio==='16:9',story=ratio==='9:16',portrait=ratio==='4:5'||ratio==='3:4';
  // Every optional business module has a usable box, even when its initial copy is empty.
  let q:Boxes={logo:b(.075,.055,.20,.045),eyebrow:b(.15,.14,.70,.035),headline:b(.10,.19,.8,.18),subheadline:b(.18,.38,.64,.07),product:b(.16,.49,.68,.30),'hero-image':b(.16,.49,.68,.30),'offer-prefix':b(.12,.65,.33,.03),'offer-value':b(.10,.69,.37,.07),'offer-suffix':b(.12,.77,.33,.04),'second-offer-value':b(.53,.69,.37,.07),'second-offer-label':b(.55,.77,.33,.04),date:b(.18,.46,.64,.04),time:b(.20,.51,.60,.035),'dress-code':b(.17,.77,.66,.04),location:b(.15,.84,.70,.04),cta:b(.24,.88,.52,.04),terms:b(.12,.94,.76,.022),scene:b(0,.50,1,.50),lamps:b(.66,0,.34,.22)};
  if(family==='PREMIUM_JEWELLERY_OFFER') {
    q={...q,logo:b(.73,.048,.19,.05),eyebrow:b(.08,.16,.84,.03),headline:b(.10,.19,.80,.065),subheadline:b(.18,.775,.64,.03),'offer-prefix':b(.12,.28,.34,.025),'offer-value':b(.08,.31,.39,.16),'offer-suffix':b(.08,.48,.39,.065),'second-offer-value':b(.53,.31,.39,.16),'second-offer-label':b(.53,.48,.39,.065),'hero-image':b(.18,.545,.64,.245),product:b(.37,.565,.26,.18),date:b(.16,.82,.68,.035),location:b(.12,.863,.76,.03),cta:b(.25,.911,.50,.033),terms:b(.14,.957,.72,.02),scene:b(0,.53,1,.27),lamps:b(.32,0,.36,.19)};
    if(story||portrait) q={...q,eyebrow:b(.08,.18,.84,.025),headline:b(.10,.22,.80,.055),'offer-prefix':b(.10,.29,.36,.024),'offer-value':b(.08,.32,.39,.14),'offer-suffix':b(.08,.465,.39,.05),'second-offer-value':b(.53,.32,.39,.14),'second-offer-label':b(.53,.465,.39,.05),'hero-image':b(.15,.535,.70,.255),scene:b(0,.52,1,.28),subheadline:b(.15,.79,.70,.027),lamps:b(.28,0,.44,.165)};
    if(wide)q={...q,logo:b(.05,.065,.15,.06),eyebrow:b(.05,.185,.55,.04),headline:b(.05,.245,.55,.11),'offer-prefix':b(.05,.38,.25,.035),'offer-value':b(.05,.425,.25,.18),'offer-suffix':b(.05,.615,.25,.09),'second-offer-value':b(.33,.425,.25,.18),'second-offer-label':b(.33,.615,.25,.09),'hero-image':b(.65,.22,.29,.52),product:b(.70,.35,.20,.34),scene:b(.62,0,.38,1),subheadline:b(.65,.80,.29,.04),date:b(.05,.75,.53,.04),location:b(.05,.805,.53,.05),cta:b(.07,.88,.40,.05),terms:b(.65,.92,.29,.025),lamps:b(.46,0,.16,.17)};
  }
  if(family==='PREMIUM_ECOMMERCE_SALE') {
    q={...q,logo:b(.14,.045,.16,.04),eyebrow:b(.18,.115,.64,.028),headline:b(.12,.16,.76,.205),date:b(.18,.385,.64,.04),subheadline:b(.14,.44,.72,.04),product:b(.14,.495,.72,.30),'offer-prefix':b(.12,.805,.24,.028),'offer-value':b(.39,.80,.49,.042),'offer-suffix':b(.35,.85,.3,.02),cta:b(.24,.885,.52,.04),scene:b(0,.40,1,.5),lamps:b(.79,0,.21,.24)};
    if(story||portrait)q={...q,eyebrow:b(.16,.12,.68,.03),headline:b(.10,.17,.80,story?.15:.18),date:b(.17,story?.345:.37,.66,.035),subheadline:b(.12,story?.395:.415,.76,.043),product:b(.12,.475,.76,story?.30:.31),scene:b(0,.43,1,.42)};
    if(wide)q={...q,logo:b(.055,.06,.16,.06),eyebrow:b(.06,.17,.43,.04),headline:b(.06,.24,.45,.25),date:b(.06,.525,.43,.06),subheadline:b(.06,.60,.43,.07),product:b(.55,.18,.40,.58),'offer-prefix':b(.56,.78,.18,.035),'offer-value':b(.75,.76,.20,.07),'offer-suffix':b(.70,.85,.18,.025),cta:b(.10,.765,.33,.065),terms:b(.07,.92,.43,.025),scene:b(.51,0,.49,1),lamps:b(.85,0,.15,.24)};
  }
  if(family==='ELEGANT_GREETING') {
    q={...q,eyebrow:b(.32,.19,.60,.027),headline:b(.34,.255,.58,.20),subheadline:b(.38,.48,.54,.075),'hero-image':b(.025,.545,.70,.36),scene:b(0,.58,1,.42),cta:b(.24,.873,.52,.037),terms:b(.15,.935,.70,.025),'offer-prefix':b(.05,.66,.20,.025),'offer-value':b(.05,.70,.20,.07),'offer-suffix':b(.05,.78,.20,.04),lamps:b(.75,.07,.20,.12)};
    if(story||portrait) q={...q,eyebrow:b(.26,.205,.68,.027),headline:b(.28,.26,.64,.16),subheadline:b(.32,.455,.60,.065),'hero-image':b(.01,.545,.80,.33),scene:b(0,.51,1,.49),cta:b(.24,.87,.52,.033)};
    if(wide)q={...q,eyebrow:b(.055,.21,.47,.04),headline:b(.065,.29,.45,.30),subheadline:b(.07,.61,.44,.11),'hero-image':b(.63,.13,.29,.75),scene:b(.57,0,.43,1),cta:b(.105,.785,.37,.055),terms:b(.06,.925,.45,.028),'offer-prefix':b(.53,.10,.08,.03),'offer-value':b(.53,.15,.08,.07),'offer-suffix':b(.53,.24,.08,.04),lamps:b(.43,.02,.13,.18)};
  }
  if(family==='LANTERN_NIGHT') {
    q={...q,logo:b(.07,.045,.18,.04),eyebrow:b(.12,.15,.76,.025),headline:b(.12,.20,.76,.20),subheadline:b(.18,.42,.64,.085),'hero-image':b(0,.34,1,.66),scene:b(0,0,1,1),cta:b(.27,.88,.46,.045),terms:b(.15,.95,.70,.025),lamps:b(.78,.04,.20,.22),'offer-prefix':b(.08,.63,.3,.025),'offer-value':b(.08,.67,.3,.065),'offer-suffix':b(.08,.745,.3,.035)};
    if(story||portrait)q={...q,eyebrow:b(.13,.17,.74,.03),headline:b(.12,.235,.76,.155),subheadline:b(.18,.415,.64,.085),'hero-image':b(0,.355,1,.645),cta:b(.24,.88,.52,.04)};
    if(wide)q={...q,logo:b(.045,.06,.16,.055),eyebrow:b(.06,.23,.43,.04),headline:b(.06,.295,.43,.26),subheadline:b(.07,.575,.41,.14),'hero-image':b(.54,0,.46,1),cta:b(.08,.795,.39,.06),terms:b(.06,.92,.44,.03),lamps:b(.42,.01,.11,.15)};
  }
  if(family==='PREMIUM_EVENT') {
    q={...q,logo:b(.14,.05,.17,.04),eyebrow:b(.17,.20,.66,.03),headline:b(.11,.25,.78,.19),date:b(.18,.48,.64,.042),time:b(.24,.535,.52,.04),subheadline:b(.25,.79,.50,.038),'dress-code':b(.25,.735,.50,.035),location:b(.25,.835,.50,.036),cta:b(.24,.889,.52,.043),terms:b(.18,.95,.64,.025),product:b(.075,.61,.85,.10),scene:b(0,.55,1,.45),lamps:b(.25,0,.50,.18)};
    if(story||portrait) q={...q,eyebrow:b(.14,.205,.72,.03),headline:b(.10,.255,.80,.15),date:b(.15,.44,.70,.04),time:b(.24,.49,.52,.035),product:b(.075,.565,.85,.14),scene:b(0,.52,1,.48),lamps:b(.20,0,.60,.18)};
    if(wide)q={...q,logo:b(.04,.06,.14,.05),eyebrow:b(.25,.155,.50,.04),headline:b(.23,.22,.54,.23),date:b(.28,.49,.44,.05),time:b(.35,.56,.30,.04),'dress-code':b(.28,.63,.44,.035),subheadline:b(.25,.695,.50,.055),location:b(.26,.77,.48,.045),cta:b(.32,.84,.36,.05),terms:b(.27,.935,.46,.025),product:b(.04,.30,.16,.54),scene:b(0,0,1,1),lamps:b(.74,0,.20,.33)};
  }
  if(family==='PREMIUM_PRODUCT_GIFT') {
    q={...q,eyebrow:b(.13,.145,.74,.028),product:b(.49,.265,.31,.42),headline:b(.12,.705,.76,.075),subheadline:b(.14,.80,.72,.062),cta:b(.24,.885,.52,.038),terms:b(.17,.95,.66,.022),scene:b(0,.14,1,.60),lamps:b(.78,.02,.18,.12),'offer-prefix':b(.07,.46,.19,.03),'offer-value':b(.07,.50,.19,.08),'offer-suffix':b(.07,.595,.19,.04)};
    if(story||portrait)q={...q,eyebrow:b(.12,.15,.76,.027),product:b(.46,.30,.34,.38),headline:b(.10,.71,.80,.075),subheadline:b(.13,.795,.74,.062),scene:b(0,.18,1,.55)};
    if(wide)q={...q,logo:b(.055,.06,.16,.055),eyebrow:b(.59,.23,.35,.04),product:b(.32,.32,.19,.55),headline:b(.59,.35,.35,.15),subheadline:b(.60,.54,.33,.12),cta:b(.60,.74,.33,.06),terms:b(.59,.91,.35,.03),scene:b(0,0,.56,1),lamps:b(.82,.02,.15,.16)};
  }
  if(family==='PREMIUM_EVENT')q={...q,terms:{...q.terms,x:.25,width:.50},date:{...q.date,x:wide?.28:.25,width:wide?.44:.50},'offer-prefix':wide?b(.05,.82,.15,.025):b(.30,.60,.40,.025),'offer-value':wide?b(.05,.85,.15,.055):b(.30,.64,.40,.045),'offer-suffix':wide?b(.05,.915,.15,.025):b(.30,.695,.40,.025)};
  // Portrait is not a scaled story: 3:4 uses a little more space for photographic scenes.
  if(ratio==='3:4')for(const role of ['product','hero-image'])q[role]={...q[role],y:q[role].y+.004,height:q[role].height-.004};
  return q;
}
