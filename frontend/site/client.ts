/**
 * The little script behind the public pages: it reveals sections as they are scrolled to, makes cards glow under the pointer, and runs the
 * "what if" example. Everything works (just without motion) when it does not run, and it does nothing while the signed-in app is showing.
 */
export const CLIENT_SCRIPT = `<script>
(function(){
var d=document,h=d.documentElement;
if(h.classList.contains('app'))return;
h.classList.add('pt-js');
var rm=matchMedia('(prefers-reduced-motion: reduce)').matches;
var els=[].slice.call(d.querySelectorAll('[data-r]'));
if(rm||!('IntersectionObserver' in window)){els.forEach(function(e){e.classList.add('pt-in')})}
else{var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('pt-in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -10% 0px',threshold:.08});els.forEach(function(e){io.observe(e)})}
if(!rm&&matchMedia('(hover: hover)').matches){d.addEventListener('pointermove',function(ev){var t=ev.target&&ev.target.closest&&ev.target.closest('.pt-tile,.pt-card');if(!t)return;var r=t.getBoundingClientRect();t.style.setProperty('--mx',(ev.clientX-r.left)+'px');t.style.setProperty('--my',(ev.clientY-r.top)+'px')},{passive:true})}
var st=d.querySelector('.pt-sticky'),hero=d.querySelector('.pt-hero');
if(st&&hero&&'IntersectionObserver' in window){new IntersectionObserver(function(es){st.classList.toggle('pt-show',!es[0].isIntersecting)},{threshold:0}).observe(hero)}
var w=d.querySelector('.pt-whatif');
if(w){
  var DUE=40,OPEN=14,PACE=7/28,PEOPLE=2,k=0,out=w.querySelector('output'),b=w.querySelector('[data-res]'),sub=w.querySelector('[data-sub]'),chip=d.querySelector('[data-chip]'),meta=d.querySelector('[data-meta]');
  function days(n){return n+' day'+(n===1?'':'s')}
  function render(){
    var f=(PEOPLE+0.7*k)/PEOPLE,fin=Math.ceil(OPEN/(PACE*f)),late=fin-DUE;
    out.textContent=k+(k===1?' person':' people');
    b.textContent='Finishes in '+days(fin);b.className=late>0?'pt-bad':'pt-ok';
    sub.textContent=late>0?days(late)+' after the due date':late<0?days(-late)+' before the due date':'on the due date';
    if(chip){chip.className='pt-chip pt-'+(late>6?'bad':late>0?'warn':'ok');chip.textContent=late>6?'At risk':late>0?'Watch':'On track'}
    if(meta){meta.textContent=late>0?'Forecast '+days(late)+' late':late<0?'Forecast '+days(-late)+' early':'Forecast on the planned date'}
  }
  w.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-step]');if(!t)return;k=Math.max(0,Math.min(6,k+(+t.getAttribute('data-step'))));render()});
  render();
}
})();
</script>`;
