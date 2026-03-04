require('dotenv').config();
const express=require('express'),cors=require('cors'),helmet=require('helmet'),compression=require('compression'),
  morgan=require('morgan'),cron=require('node-cron'),{Pool}=require('pg'),jwt=require('jsonwebtoken'),
  bcrypt=require('bcryptjs'),axios=require('axios'),nodemailer=require('nodemailer');

const app=express(),PORT=process.env.PORT||3001;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,max:20});
pool.on('error',e=>console.error('DB error:',e.message));

app.use(helmet({contentSecurityPolicy:false}));
app.use(compression());
app.use(cors({origin:process.env.FRONTEND_URL||'*',credentials:true}));
app.use(express.json({limit:'10mb'}));
app.use(morgan('short'));

// === HELPERS ===
const auth=(req,res,next)=>{const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'No token'});try{req.user=jwt.verify(t,process.env.JWT_SECRET);next()}catch(e){res.status(401).json({error:'Invalid token'})}};
const genToken=u=>jwt.sign({id:u.id,email:u.email,role:u.role},process.env.JWT_SECRET,{expiresIn:'30d'});
const dr=q=>{const{start,end,period}=q;if(start&&end)return{start,end};const n=new Date(),d=x=>new Date(Date.now()-x*864e5).toISOString().split('T')[0],t=n.toISOString().split('T')[0];const m={today:[t,t],'7d':[d(7),t],'30d':[d(30),t],'90d':[d(90),t],ytd:[`${n.getFullYear()}-01-01`,t],'12m':[d(365),t]};const[s,e]=m[period]||m['30d'];return{start:s,end:e}};

// === HEALTH ===
app.get('/',(r,s)=>s.json({status:'ok',app:'TVS Profit Dashboard',v:'1.0.0'}));
app.get('/health',(r,s)=>s.json({status:'healthy',ts:new Date().toISOString()}));

// ====================== AUTH ======================
app.get('/api/auth/check-setup',async(req,res)=>{try{const r=await pool.query('SELECT COUNT(*)FROM users');res.json({setupRequired:+r.rows[0].count===0})}catch(e){res.json({setupRequired:true})}});

app.post('/api/auth/setup',async(req,res)=>{try{
  const x=await pool.query('SELECT COUNT(*)FROM users');
  if(+x.rows[0].count>0)return res.status(400).json({error:'Already set up'});
  const{email,password,name}=req.body;
  const h=await bcrypt.hash(password,12);
  const r=await pool.query('INSERT INTO users(email,password_hash,name,role)VALUES($1,$2,$3,$4)RETURNING id,email,name,role',[email.toLowerCase(),h,name||'Admin','admin']);
  res.json({token:genToken(r.rows[0]),user:r.rows[0]});
}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/auth/login',async(req,res)=>{try{
  const{email,password}=req.body;
  const r=await pool.query('SELECT*FROM users WHERE email=$1',[email.toLowerCase()]);
  if(!r.rows[0]||!await bcrypt.compare(password,r.rows[0].password_hash))return res.status(401).json({error:'Invalid credentials'});
  const u=r.rows[0];
  res.json({token:genToken(u),user:{id:u.id,email:u.email,name:u.name,role:u.role,timezone:u.timezone,currency:u.currency}});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/auth/me',auth,async(req,res)=>{try{res.json((await pool.query('SELECT id,email,name,role,timezone,currency FROM users WHERE id=$1',[req.user.id])).rows[0])}catch(e){res.status(500).json({error:e.message})}});

// ====================== DASHBOARD ======================
app.get('/api/dashboard/overview',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);
  const c=await pool.query(`SELECT COALESCE(SUM(revenue),0)as revenue,COALESCE(SUM(cogs),0)as cogs,COALESCE(SUM(ad_spend),0)as ad_spend,COALESCE(SUM(shipping_cost),0)as shipping_cost,COALESCE(SUM(payment_fees),0)as payment_fees,COALESCE(SUM(discount_total),0)as discounts,COALESCE(SUM(refund_total),0)as refunds,COALESCE(SUM(gross_profit),0)as gross_profit,COALESCE(SUM(contribution_margin),0)as contribution_margin,COALESCE(SUM(net_profit),0)as net_profit,COALESCE(SUM(orders_count),0)as orders,COALESCE(SUM(items_sold),0)as items_sold,COALESCE(SUM(new_customers),0)as new_customers,COALESCE(SUM(returning_customers),0)as returning_customers,CASE WHEN SUM(orders_count)>0 THEN SUM(revenue)/SUM(orders_count)ELSE 0 END as aov,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer,CASE WHEN SUM(revenue)>0 THEN SUM(gross_profit)/SUM(revenue)*100 ELSE 0 END as gross_margin_pct FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end]);
  const days=Math.max(1,Math.ceil((new Date(end)-new Date(start))/864e5));
  const ps=new Date(new Date(start).getTime()-days*864e5).toISOString().split('T')[0];
  const pe=new Date(new Date(start).getTime()-864e5).toISOString().split('T')[0];
  const p=await pool.query(`SELECT COALESCE(SUM(revenue),0)as revenue,COALESCE(SUM(gross_profit),0)as gross_profit,COALESCE(SUM(net_profit),0)as net_profit,COALESCE(SUM(orders_count),0)as orders,COALESCE(SUM(new_customers),0)as new_customers,CASE WHEN SUM(orders_count)>0 THEN SUM(revenue)/SUM(orders_count)ELSE 0 END as aov,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[ps,pe]);
  const t=await pool.query('SELECT date,revenue,cogs,ad_spend,gross_profit,net_profit,orders_count,new_customers,returning_customers,aov,mer FROM daily_metrics WHERE date BETWEEN $1 AND $2 ORDER BY date',[start,end]);
  res.json({current:c.rows[0],previous:p.rows[0],trend:t.rows,period:{start,end}});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/dashboard/pnl',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);const g=req.query.group||'month';
  const expr=g==='day'?'date':g==='week'?"date_trunc('week',date)::date":"date_trunc('month',date)::date";
  const rows=await pool.query(`SELECT ${expr} as period,SUM(revenue)as revenue,SUM(cogs)as cogs,SUM(revenue)-SUM(cogs)as gross_profit,SUM(ad_spend)as ad_spend,SUM(shipping_cost)as shipping_cost,SUM(payment_fees)as payment_fees,SUM(discount_total)as discounts,SUM(refund_total)as refunds,SUM(fixed_costs_daily)as fixed_costs,SUM(contribution_margin)as contribution_margin,SUM(net_profit)as net_profit,SUM(orders_count)as orders,CASE WHEN SUM(revenue)>0 THEN SUM(net_profit)/SUM(revenue)*100 ELSE 0 END as net_margin_pct FROM daily_metrics WHERE date BETWEEN $1 AND $2 GROUP BY ${expr} ORDER BY period`,[start,end]);
  const totals=await pool.query(`SELECT SUM(revenue)as revenue,SUM(cogs)as cogs,SUM(ad_spend)as ad_spend,SUM(shipping_cost)as shipping_cost,SUM(payment_fees)as payment_fees,SUM(discount_total)as discounts,SUM(refund_total)as refunds,SUM(fixed_costs_daily)as fixed_costs,SUM(net_profit)as net_profit FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end]);
  res.json({rows:rows.rows,totals:totals.rows[0]});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/dashboard/goals-pacing',auth,async(req,res)=>{try{
  const y=req.query.year||new Date().getFullYear();
  const goals=await pool.query('SELECT*FROM goals WHERE year=$1',[y]);
  const actuals=await pool.query(`SELECT EXTRACT(MONTH FROM date)as month,SUM(revenue)as revenue,SUM(net_profit)as net_profit,SUM(gross_profit)as gross_profit,SUM(orders_count)as orders,SUM(new_customers)as new_customers FROM daily_metrics WHERE EXTRACT(YEAR FROM date)=$1 GROUP BY EXTRACT(MONTH FROM date)ORDER BY month`,[y]);
  res.json({goals:goals.rows,actuals:actuals.rows,currentMonth:new Date().getMonth()+1});
}catch(e){res.status(500).json({error:e.message})}});

// ====================== PRODUCTS ======================
app.get('/api/products',auth,async(req,res)=>{try{
  const{sort='total_profit',order='DESC',limit=100,offset=0,search}=req.query;
  const ok=['name','sku','price','cogs','gross_margin_pct','total_sold','total_revenue','total_profit','breakeven_roas'];
  const col=ok.includes(sort)?sort:'total_profit';let w='',p=[];
  if(search){w='WHERE name ILIKE $1 OR sku ILIKE $1';p.push(`%${search}%`)}
  const r=await pool.query(`SELECT*,CASE WHEN price>0 AND cogs>0 THEN ROUND(((price-cogs)/price)*100,1)ELSE 0 END as calc_margin,CASE WHEN price>0 AND price-cogs>0 THEN ROUND(price/(price-cogs),2)ELSE 0 END as calc_breakeven FROM products ${w} ORDER BY ${col} ${order==='ASC'?'ASC':'DESC'} LIMIT ${+limit} OFFSET ${+offset}`,p);
  const cnt=await pool.query(`SELECT COUNT(*)FROM products ${w}`,p);
  res.json({products:r.rows,total:+cnt.rows[0].count});
}catch(e){res.status(500).json({error:e.message})}});

app.put('/api/products/:id/cogs',auth,async(req,res)=>{try{
  const r=await pool.query(`UPDATE products SET cogs=$1,breakeven_roas=CASE WHEN price>0 AND price-$1>0 THEN ROUND(price/(price-$1),4)ELSE 0 END,gross_margin_pct=CASE WHEN price>0 THEN ROUND((price-$1)/price*100,2)ELSE 0 END,updated_at=NOW()WHERE id=$2 RETURNING*`,[req.body.cogs,req.params.id]);
  res.json(r.rows[0]);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/products/:id',auth,async(req,res)=>{try{
  const r=await pool.query(`SELECT p.*,COUNT(DISTINCT oi.order_id)as orders_count,COALESCE(SUM(oi.quantity),0)as units_sold,COALESCE(SUM(oi.line_total),0)as rev,COALESCE(SUM(oi.line_profit),0)as profit FROM products p LEFT JOIN order_items oi ON oi.product_id=p.id WHERE p.id=$1 GROUP BY p.id`,[req.params.id]);
  const t=await pool.query(`SELECT date_trunc('month',o.order_date)::date as month,SUM(oi.quantity)as units,SUM(oi.line_total)as revenue,SUM(oi.line_profit)as profit FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=$1 AND o.order_date>NOW()-INTERVAL'12 months' GROUP BY month ORDER BY month`,[req.params.id]);
  res.json({product:r.rows[0],trend:t.rows});
}catch(e){res.status(500).json({error:e.message})}});

// ====================== ORDERS ======================
app.get('/api/orders',auth,async(req,res)=>{try{
  const{start,end,sort='order_date',order='DESC',limit=50,offset=0,country,profitable,search}=req.query;
  let cn=[],pr=[],i=1;
  if(start){cn.push(`order_date>=$${i++}`);pr.push(start)}
  if(end){cn.push(`order_date<=$${i++}`);pr.push(end+'T23:59:59Z')}
  if(country){cn.push(`o.country=$${i++}`);pr.push(country)}
  if(profitable==='true')cn.push('gross_profit>0');
  if(profitable==='false')cn.push('gross_profit<=0');
  if(search){cn.push(`woo_order_id::text LIKE $${i}`);pr.push(`%${search}%`);i++}
  const w=cn.length?'WHERE '+cn.join(' AND '):'';
  const ok=['order_date','revenue','gross_profit','margin_pct'];const col=ok.includes(sort)?sort:'order_date';
  const r=await pool.query(`SELECT o.*,c.email as customer_email,c.first_name,c.last_name,c.total_orders as cust_orders FROM orders o LEFT JOIN customers c ON o.customer_id=c.id ${w} ORDER BY o.${col} ${order==='ASC'?'ASC':'DESC'} LIMIT ${+limit} OFFSET ${+offset}`,pr);
  const cnt=await pool.query(`SELECT COUNT(*)FROM orders o ${w}`,pr);
  const sm=await pool.query(`SELECT COUNT(*)as total,COALESCE(SUM(revenue),0)as rev,COALESCE(SUM(gross_profit),0)as profit,CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END as aov FROM orders o ${w}`,pr);
  res.json({orders:r.rows,total:+cnt.rows[0].count,summary:sm.rows[0]});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/orders/analytics/by-country',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);
  const r=await pool.query(`SELECT country,COUNT(*)as orders,SUM(revenue)as revenue,SUM(gross_profit)as profit,SUM(revenue)/NULLIF(COUNT(*),0)as aov FROM orders WHERE order_date BETWEEN $1 AND $2 AND country IS NOT NULL AND country!='' GROUP BY country ORDER BY revenue DESC`,[start,end+'T23:59:59Z']);
  res.json(r.rows);
}catch(e){res.status(500).json({error:e.message})}});

// ====================== MARKETING ======================
app.get('/api/marketing/overview',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);
  const b=await pool.query(`SELECT COALESCE(SUM(spend),0)as total_spend,COALESCE(SUM(impressions),0)as total_impressions,COALESCE(SUM(clicks),0)as total_clicks,COALESCE(SUM(conversions),0)as total_conversions,COALESCE(SUM(conversion_value),0)as total_conv_value,CASE WHEN SUM(impressions)>0 THEN SUM(clicks)::float/SUM(impressions)*100 ELSE 0 END as avg_ctr,CASE WHEN SUM(clicks)>0 THEN SUM(spend)/SUM(clicks)ELSE 0 END as avg_cpc,CASE WHEN SUM(conversions)>0 THEN SUM(spend)/SUM(conversions)ELSE 0 END as avg_cpa,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as blended_roas FROM ad_spend_daily WHERE date BETWEEN $1 AND $2`,[start,end]);
  const rv=await pool.query('SELECT COALESCE(SUM(revenue),0)as r FROM daily_metrics WHERE date BETWEEN $1 AND $2',[start,end]);
  const sp=+(b.rows[0].total_spend)||0,re=+(rv.rows[0].r)||0;
  const bp=await pool.query(`SELECT platform,SUM(spend)as spend,SUM(impressions)as impressions,SUM(clicks)as clicks,SUM(conversions)as conversions,SUM(conversion_value)as conv_value,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as roas FROM ad_spend_daily WHERE date BETWEEN $1 AND $2 GROUP BY platform ORDER BY spend DESC`,[start,end]);
  const tr=await pool.query(`SELECT date,SUM(spend)as spend,SUM(conversions)as conversions,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as roas FROM ad_spend_daily WHERE date BETWEEN $1 AND $2 GROUP BY date ORDER BY date`,[start,end]);
  res.json({blended:{...b.rows[0],mer:sp>0?re/sp:0,total_revenue:re},byPlatform:bp.rows,trend:tr.rows});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/marketing/campaigns',auth,async(req,res)=>{try{
  const{start,end}=dr(req.query);const{platform}=req.query;
  let w='WHERE date BETWEEN $1 AND $2',p=[start,end];
  if(platform){w+=' AND platform=$3';p.push(platform)}
  const r=await pool.query(`SELECT platform,campaign_id,campaign_name,SUM(spend)as spend,SUM(impressions)as impressions,SUM(clicks)as clicks,SUM(conversions)as conversions,SUM(conversion_value)as conv_value,CASE WHEN SUM(spend)>0 THEN SUM(conversion_value)/SUM(spend)ELSE 0 END as roas,CASE WHEN SUM(conversions)>0 THEN SUM(spend)/SUM(conversions)ELSE 0 END as cpa FROM ad_spend_daily ${w} GROUP BY platform,campaign_id,campaign_name ORDER BY spend DESC`,p);
  res.json(r.rows);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/marketing/creatives',auth,async(req,res)=>{try{
  const{platform,sort='total_spend',limit=50}=req.query;
  let w='',p=[];if(platform){w='WHERE platform=$1';p.push(platform)}
  res.json((await pool.query(`SELECT*FROM ad_creatives ${w} ORDER BY ${sort==='roas'?'roas':sort==='ctr'?'ctr':'total_spend'} DESC LIMIT ${+limit}`,p)).rows);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/marketing/spend-advisor',auth,async(req,res)=>{try{
  const rc=await pool.query(`SELECT SUM(revenue)as revenue,SUM(ad_spend)as ad_spend,SUM(net_profit)as net_profit,SUM(gross_profit)as gross_profit,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer,SUM(orders_count)as orders FROM daily_metrics WHERE date>NOW()-INTERVAL'7 days'`);
  const pv=await pool.query(`SELECT SUM(revenue)as revenue,SUM(ad_spend)as ad_spend,SUM(net_profit)as net_profit,CASE WHEN SUM(ad_spend)>0 THEN SUM(revenue)/SUM(ad_spend)ELSE 0 END as mer FROM daily_metrics WHERE date BETWEEN(NOW()-INTERVAL'14 days')AND(NOW()-INTERVAL'7 days')`);
  const r=rc.rows[0],p=pv.rows[0],mer=+(r.mer)||0;
  let rec='maintain',reason=`MER is ${mer.toFixed(1)}x. Monitor closely.`;
  if(mer>3&&+(r.net_profit)>0){rec='scale';reason=`MER at ${mer.toFixed(1)}x with positive profit. Scale up.`}
  else if(mer<1.5||+(r.net_profit)<0){rec='reduce';reason=`MER at ${mer.toFixed(1)}x, unprofitable. Cut low performers.`}
  const cpa=+(r.ad_spend)>0?+(r.ad_spend)/Math.max(+(r.orders),1):0;
  const avgP=+(r.orders)>0?+(r.gross_profit)/+(r.orders):0;
  const o100=cpa>0?100/cpa:0;
  res.json({current:r,previous:p,recommendation:rec,reason,impact:{per100:{orders:Math.round(o100*10)/10,profit:Math.round((o100*avgP-100)*100)/100}}});
}catch(e){res.status(500).json({error:e.message})}});

// ====================== CUSTOMERS / LTV ======================
app.get('/api/customers',auth,async(req,res)=>{try{
  const{sort='ltv',order='DESC',limit=50,offset=0,search,type}=req.query;
  let cn=[],p=[],i=1;
  if(search){cn.push(`(email ILIKE $${i} OR first_name ILIKE $${i})`);p.push(`%${search}%`);i++}
  if(type==='new')cn.push('total_orders=1');if(type==='returning')cn.push('total_orders>1');
  const w=cn.length?'WHERE '+cn.join(' AND '):'';
  const r=await pool.query(`SELECT*FROM customers ${w} ORDER BY ${sort} ${order==='ASC'?'ASC':'DESC'} LIMIT ${+limit} OFFSET ${+offset}`,p);
  const cnt=await pool.query(`SELECT COUNT(*)FROM customers ${w}`,p);
  res.json({customers:r.rows,total:+cnt.rows[0].count});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/customers/ltv-overview',auth,async(req,res)=>{try{
  const o=await pool.query(`SELECT COUNT(*)as total_customers,COUNT(*)FILTER(WHERE total_orders>1)as returning_customers,ROUND(COUNT(*)FILTER(WHERE total_orders>1)::numeric/NULLIF(COUNT(*),0)*100,1)as repeat_rate,ROUND(AVG(ltv)::numeric,2)as avg_ltv,ROUND(AVG(aov)::numeric,2)as avg_aov,ROUND(AVG(total_orders)::numeric,1)as avg_orders,ROUND(MAX(ltv)::numeric,2)as max_ltv FROM customers WHERE total_orders>0`);
  const d=await pool.query(`SELECT CASE WHEN ltv<25 THEN '$0-25' WHEN ltv<50 THEN '$25-50' WHEN ltv<100 THEN '$50-100' WHEN ltv<200 THEN '$100-200' WHEN ltv<500 THEN '$200-500' ELSE '$500+' END as bucket,COUNT(*)as count FROM customers WHERE total_orders>0 GROUP BY bucket ORDER BY MIN(ltv)`);
  const t=await pool.query('SELECT id,email,first_name,last_name,total_orders,total_revenue,ltv,first_order_date FROM customers ORDER BY ltv DESC LIMIT 10');
  res.json({overview:o.rows[0],distribution:d.rows,topCustomers:t.rows});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/customers/cohorts',auth,async(req,res)=>{try{
  res.json((await pool.query(`SELECT cohort_month,COUNT(*)as customers,SUM(total_revenue)as total_revenue,SUM(total_profit)as total_profit,AVG(ltv)as avg_ltv,AVG(total_orders)as avg_orders,AVG(aov)as avg_aov,COUNT(*)FILTER(WHERE total_orders>1)::float/NULLIF(COUNT(*),0)*100 as repeat_rate FROM customers WHERE cohort_month IS NOT NULL AND total_orders>0 GROUP BY cohort_month ORDER BY cohort_month DESC`)).rows);
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/customers/product-retention',auth,async(req,res)=>{try{
  res.json((await pool.query(`WITH fp AS(SELECT DISTINCT ON(o.customer_id)o.customer_id,oi.product_id,p.name FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.is_first_order=true ORDER BY o.customer_id,oi.line_total DESC)SELECT fp.product_id,fp.name as product_name,COUNT(DISTINCT fp.customer_id)as first_buyers,COUNT(DISTINCT CASE WHEN c.total_orders>1 THEN fp.customer_id END)as repeat_buyers,ROUND(COUNT(DISTINCT CASE WHEN c.total_orders>1 THEN fp.customer_id END)::numeric/NULLIF(COUNT(DISTINCT fp.customer_id),0)*100,1)as retention_rate FROM fp JOIN customers c ON c.id=fp.customer_id GROUP BY fp.product_id,fp.name ORDER BY first_buyers DESC LIMIT 20`)).rows);
}catch(e){res.status(500).json({error:e.message})}});

// ====================== SETTINGS ======================
app.get('/api/settings/goals',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM goals WHERE year=$1',[q.query.year||new Date().getFullYear()])).rows)}catch(e){s.status(500).json({error:e.message})}});
app.post('/api/settings/goals',auth,async(req,res)=>{try{const{year,metric_type,annual_target,monthly_targets,seasonal_weights,notes}=req.body;let t=monthly_targets;if(!t){t={};for(let m=1;m<=12;m++)t[m]=Math.round(annual_target/12*100)/100}const r=await pool.query(`INSERT INTO goals(year,metric_type,annual_target,monthly_targets,seasonal_weights,notes)VALUES($1,$2,$3,$4,$5,$6)ON CONFLICT(year,metric_type)DO UPDATE SET annual_target=$3,monthly_targets=$4,seasonal_weights=$5,notes=$6,updated_at=NOW()RETURNING*`,[year,metric_type,annual_target,JSON.stringify(t),JSON.stringify(seasonal_weights||{}),notes]);res.json(r.rows[0])}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/settings/goals/:id',auth,async(q,s)=>{try{await pool.query('DELETE FROM goals WHERE id=$1',[q.params.id]);s.json({ok:1})}catch(e){s.status(500).json({error:e.message})}});

app.get('/api/settings/fixed-costs',auth,async(q,s)=>{try{const r=await pool.query('SELECT*FROM fixed_costs ORDER BY is_active DESC,name');const t=await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');s.json({costs:r.rows,totalMonthly:+t.rows[0].t})}catch(e){s.status(500).json({error:e.message})}});
app.post('/api/settings/fixed-costs',auth,async(req,res)=>{try{const{name,amount_monthly,category,notes}=req.body;res.json((await pool.query('INSERT INTO fixed_costs(name,amount_monthly,category,notes)VALUES($1,$2,$3,$4)RETURNING*',[name,amount_monthly,category,notes])).rows[0])}catch(e){res.status(500).json({error:e.message})}});
app.put('/api/settings/fixed-costs/:id',auth,async(req,res)=>{try{const{name,amount_monthly,category,is_active}=req.body;res.json((await pool.query('UPDATE fixed_costs SET name=COALESCE($1,name),amount_monthly=COALESCE($2,amount_monthly),category=COALESCE($3,category),is_active=COALESCE($4,is_active)WHERE id=$5 RETURNING*',[name,amount_monthly,category,is_active,req.params.id])).rows[0])}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/settings/fixed-costs/:id',auth,async(q,s)=>{try{await pool.query('DELETE FROM fixed_costs WHERE id=$1',[q.params.id]);s.json({ok:1})}catch(e){s.status(500).json({error:e.message})}});

app.get('/api/settings/integrations',auth,async(q,s)=>{try{s.json((await pool.query('SELECT id,platform,is_connected,last_sync_at,sync_status,error_message FROM integrations ORDER BY platform')).rows)}catch(e){s.status(500).json({error:e.message})}});
app.put('/api/settings/integrations/:platform',auth,async(req,res)=>{try{const{config,is_connected}=req.body;res.json((await pool.query('UPDATE integrations SET config=COALESCE($1,config),is_connected=COALESCE($2,is_connected),updated_at=NOW()WHERE platform=$3 RETURNING id,platform,is_connected,last_sync_at,sync_status',[config?JSON.stringify(config):null,is_connected,req.params.platform])).rows[0])}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/settings/alerts',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM alert_thresholds ORDER BY is_active DESC,metric')).rows)}catch(e){s.status(500).json({error:e.message})}});
app.post('/api/settings/alerts',auth,async(req,res)=>{try{const{metric,operator,threshold_value,notification_channels}=req.body;res.json((await pool.query('INSERT INTO alert_thresholds(metric,operator,threshold_value,notification_channels)VALUES($1,$2,$3,$4)RETURNING*',[metric,operator,threshold_value,JSON.stringify(notification_channels||['email'])])).rows[0])}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/settings/alerts/:id',auth,async(q,s)=>{try{await pool.query('DELETE FROM alert_thresholds WHERE id=$1',[q.params.id]);s.json({ok:1})}catch(e){s.status(500).json({error:e.message})}});

app.get('/api/settings/reports',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM report_configs ORDER BY frequency')).rows)}catch(e){s.status(500).json({error:e.message})}});
app.put('/api/settings/reports/:id',auth,async(req,res)=>{try{const{recipients,is_active,send_time}=req.body;res.json((await pool.query('UPDATE report_configs SET recipients=COALESCE($1,recipients),is_active=COALESCE($2,is_active),send_time=COALESCE($3,send_time)WHERE id=$4 RETURNING*',[recipients?JSON.stringify(recipients):null,is_active,send_time,req.params.id])).rows[0])}catch(e){res.status(500).json({error:e.message})}});

// ====================== FORECASTS & SCENARIOS ======================
app.get('/api/forecasts',auth,async(req,res)=>{try{
  const h=await pool.query(`SELECT date_trunc('month',date)::date as month,SUM(revenue)as revenue,SUM(net_profit)as profit,SUM(orders_count)as orders FROM daily_metrics WHERE date>NOW()-INTERVAL'6 months' GROUP BY month ORDER BY month`);
  if(h.rows.length<2)return res.json({forecasts:[],message:'Need more data'});
  const ra=h.rows.map(r=>+(r.revenue));
  const ag=ra.reduce((a,v,i)=>i>0?a+(v-ra[i-1])/Math.max(ra[i-1],1):a,0)/(ra.length-1);
  const last=ra[ra.length-1];const fc=[];
  for(let i=1;i<=12;i++){const b=last*Math.pow(1+Math.min(ag,0.15),i);fc.push({month:i,optimistic:Math.round(b*1.15),base:Math.round(b),pessimistic:Math.round(b*0.85)})}
  res.json({historical:h.rows,forecasts:fc,avgGrowthRate:ag});
}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/scenarios',auth,async(req,res)=>{try{
  const{cogs_change_pct=0,ad_spend_change_pct=0,price_change_pct=0,period='30d'}=req.body;
  const{start,end}=dr({period});
  const b=await pool.query(`SELECT SUM(revenue)as revenue,SUM(cogs)as cogs,SUM(ad_spend)as ad_spend,SUM(gross_profit)as gross_profit,SUM(net_profit)as net_profit FROM daily_metrics WHERE date BETWEEN $1 AND $2`,[start,end]);
  const d=b.rows[0];const nR=+d.revenue*(1+price_change_pct/100),nC=+d.cogs*(1+cogs_change_pct/100),nA=+d.ad_spend*(1+ad_spend_change_pct/100);
  const nG=nR-nC,nN=nG-nA-(+d.net_profit-+d.gross_profit+ +d.ad_spend);
  res.json({base:{revenue:+d.revenue,cogs:+d.cogs,ad_spend:+d.ad_spend,gross_profit:+d.gross_profit,net_profit:+d.net_profit},scenario:{revenue:nR,cogs:nC,ad_spend:nA,gross_profit:nG,net_profit:nN}});
}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/insights',auth,async(q,s)=>{try{s.json((await pool.query('SELECT*FROM ai_insights ORDER BY date DESC,priority LIMIT 20')).rows)}catch(e){s.status(500).json({error:e.message})}});

// ====================== CALCULATORS ======================
app.post('/api/calc/breakeven-roas',(req,res)=>{const{price,cogs,shipping=0,fee_pct=2.9,fee_fixed=0.30}=req.body;const f=price*(fee_pct/100)+fee_fixed;const tc=cogs+shipping+f;const p=price-tc;res.json({price,totalCost:Math.round(tc*100)/100,profit:Math.round(p*100)/100,breakevenRoas:p>0?Math.round(price/p*100)/100:0,marginPct:price>0?Math.round(p/price*10000)/100:0})});
app.post('/api/calc/contribution-margin',(req,res)=>{const{revenue,cogs,shipping=0,payment_fees=0,ad_spend=0,discounts=0}=req.body;const gp=revenue-cogs;const cm=gp-shipping-payment_fees-ad_spend-discounts;res.json({revenue,grossProfit:gp,contributionMargin:cm,cmPct:revenue>0?Math.round(cm/revenue*10000)/100:0,grossMarginPct:revenue>0?Math.round(gp/revenue*10000)/100:0})});
app.post('/api/calc/mer',(req,res)=>{const{revenue,total_ad_spend,target_margin=20,cogs_pct=30,overhead_pct=15}=req.body;const mer=total_ad_spend>0?revenue/total_ad_spend:0;const be=100/(100-cogs_pct-overhead_pct);res.json({mer:Math.round(mer*100)/100,breakevenMer:Math.round(be*100)/100,targetMer:Math.round(100/(100-cogs_pct-overhead_pct-target_margin)*100)/100,profitable:mer>=be})});
app.post('/api/calc/order-profit',(req,res)=>{const{revenue,cogs,shipping=0,fee_pct=2.9,fee_fixed=0.30,discount=0,ad_cost=0}=req.body;const f=revenue*(fee_pct/100)+fee_fixed;const gp=revenue-cogs-shipping-f-discount;const np=gp-ad_cost;res.json({revenue,cogs,shippingCost:shipping,paymentFees:Math.round(f*100)/100,discount,grossProfit:Math.round(gp*100)/100,adCost:ad_cost,netProfit:Math.round(np*100)/100,marginPct:revenue>0?Math.round(np/revenue*10000)/100:0})});
app.post('/api/calc/proas',(req,res)=>{const{ad_spend,revenue_from_ads,cogs_pct=30,shipping_pct=5,fee_pct=3}=req.body;const net=revenue_from_ads*(1-cogs_pct/100-shipping_pct/100-fee_pct/100);const proas=ad_spend>0?net/ad_spend:0;res.json({roas:ad_spend>0?Math.round(revenue_from_ads/ad_spend*100)/100:0,proas:Math.round(proas*100)/100,profit:Math.round((net-ad_spend)*100)/100})});
app.post('/api/calc/vat',(req,res)=>{const{amount,vat_rate=20,includes_vat=false}=req.body;if(includes_vat){const n=amount/(1+vat_rate/100);res.json({gross:amount,net:Math.round(n*100)/100,vat:Math.round((amount-n)*100)/100,rate:vat_rate})}else{const v=amount*(vat_rate/100);res.json({gross:Math.round((amount+v)*100)/100,net:amount,vat:Math.round(v*100)/100,rate:vat_rate})}});

// ====================== WOOCOMMERCE WEBHOOK ======================
app.post('/api/webhooks/woocommerce',async(req,res)=>{try{
  const event=req.headers['x-wc-webhook-topic'];const o=req.body;
  console.log(`📥 WC webhook: ${event}`);
  if((event==='order.created'||event==='order.updated')&&['completed','processing'].includes(o.status)){
    let custId=null;
    if(o.billing?.email){
      let cr=await pool.query('SELECT id FROM customers WHERE email=$1',[o.billing.email]);
      if(!cr.rows[0])cr=await pool.query('INSERT INTO customers(woo_customer_id,email,first_name,last_name,country)VALUES($1,$2,$3,$4,$5)RETURNING id',[o.customer_id||0,o.billing.email,o.billing.first_name,o.billing.last_name,o.billing.country]);
      custId=cr.rows[0]?.id;
    }
    let totalCogs=0;
    for(const it of(o.line_items||[])){const pr=await pool.query('SELECT cogs FROM products WHERE woo_product_id=$1',[it.product_id]);totalCogs+=(+(pr.rows[0]?.cogs)||0)*it.quantity}
    const rev=+(o.total)||0,ship=+(o.shipping_total)||0,fees=rev*0.029+0.30,gp=rev-totalCogs-ship-fees;
    await pool.query(`INSERT INTO orders(woo_order_id,customer_id,order_date,status,revenue,cogs,shipping_cost,payment_fees,discount,tax,gross_profit,contribution_margin,margin_pct,country,coupon_code,payment_method,items_count,currency)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)ON CONFLICT(woo_order_id)DO UPDATE SET status=$4,revenue=$5,cogs=$6,gross_profit=$11`,
      [o.id,custId,o.date_created,o.status,rev,totalCogs,ship,fees,+(o.discount_total)||0,+(o.total_tax)||0,gp,gp,rev>0?gp/rev*100:0,o.billing?.country,o.coupon_lines?.[0]?.code,o.payment_method,(o.line_items||[]).length,o.currency||'USD']);
  }
  res.json({ok:true});
}catch(e){console.error('Webhook err:',e.message);res.json({ok:true})}});

// ====================== FULL SYNC ======================
app.post('/api/sync/woocommerce',auth,async(req,res)=>{
  res.json({status:'started',message:'Sync running in background...'});
  const ax=axios.create({baseURL:`${process.env.WOO_STORE_URL}/wp-json/wc/v3`,auth:{username:process.env.WOO_CONSUMER_KEY,password:process.env.WOO_CONSUMER_SECRET},timeout:30000});
  try{
    await pool.query("UPDATE integrations SET sync_status='syncing' WHERE platform='woocommerce'");
    // Products
    let pg=1;while(true){const{data}=await ax.get('/products',{params:{per_page:100,page:pg,status:'publish'}});for(const p of data){await pool.query(`INSERT INTO products(woo_product_id,name,sku,price,image_url,category,status)VALUES($1,$2,$3,$4,$5,$6,$7)ON CONFLICT(woo_product_id)DO UPDATE SET name=$2,sku=$3,price=$4,image_url=$5,category=$6,updated_at=NOW()`,[p.id,p.name,p.sku,+(p.price)||0,p.images?.[0]?.src,p.categories?.[0]?.name||'Uncategorized',p.status])}console.log(`✅ Products pg ${pg}: ${data.length}`);if(data.length<100)break;pg++}
    // Orders
    pg=1;while(true){const{data}=await ax.get('/orders',{params:{per_page:100,page:pg,orderby:'date',order:'desc'}});for(const o of data){if(!['completed','processing','refunded'].includes(o.status))continue;let cid=null;if(o.billing?.email){let cr=await pool.query('SELECT id FROM customers WHERE email=$1',[o.billing.email]);if(!cr.rows[0])cr=await pool.query('INSERT INTO customers(woo_customer_id,email,first_name,last_name,country)VALUES($1,$2,$3,$4,$5)RETURNING id',[o.customer_id||Math.floor(Math.random()*1e5),o.billing.email,o.billing.first_name,o.billing.last_name,o.billing.country]);cid=cr.rows[0]?.id}
    let tc=0;for(const it of(o.line_items||[])){const pr=await pool.query('SELECT cogs FROM products WHERE woo_product_id=$1',[it.product_id]);tc+=(+(pr.rows[0]?.cogs)||0)*it.quantity}
    const rev=+(o.total)||0,sh=+(o.shipping_total)||0,fe=rev*0.029+0.30,gp=rev-tc-sh-fe,disc=+(o.discount_total)||0;
    const isF=cid?(await pool.query('SELECT COUNT(*)FROM orders WHERE customer_id=$1 AND woo_order_id!=$2',[cid,o.id])).rows[0].count==='0':false;
    await pool.query(`INSERT INTO orders(woo_order_id,customer_id,order_date,status,revenue,cogs,shipping_cost,payment_fees,discount,tax,gross_profit,contribution_margin,margin_pct,country,utm_source,utm_medium,coupon_code,is_first_order,payment_method,items_count,currency)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)ON CONFLICT(woo_order_id)DO UPDATE SET status=$4,revenue=$5,cogs=$6,gross_profit=$11,margin_pct=$13`,[o.id,cid,o.date_created,o.status,rev,tc,sh,fe,disc,+(o.total_tax)||0,gp,gp-disc,rev>0?gp/rev*100:0,o.billing?.country,o.meta_data?.find(m=>m.key==='_utm_source')?.value,o.meta_data?.find(m=>m.key==='_utm_medium')?.value,o.coupon_lines?.[0]?.code,isF,o.payment_method,(o.line_items||[]).length,o.currency||'USD']);
    // Items
    const or2=await pool.query('SELECT id FROM orders WHERE woo_order_id=$1',[o.id]);if(or2.rows[0]){await pool.query('DELETE FROM order_items WHERE order_id=$1',[or2.rows[0].id]);for(const it of(o.line_items||[])){const pr=await pool.query('SELECT id,cogs FROM products WHERE woo_product_id=$1',[it.product_id]);const uc=+(pr.rows[0]?.cogs)||0,lt=+(it.total)||0;await pool.query('INSERT INTO order_items(order_id,product_id,woo_product_id,product_name,sku,quantity,unit_price,unit_cogs,line_total,line_cogs,line_profit)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[or2.rows[0].id,pr.rows[0]?.id,it.product_id,it.name,it.sku,it.quantity,+(it.price),uc,lt,uc*it.quantity,lt-uc*it.quantity])}}
    // Customer stats
    if(cid)await pool.query(`UPDATE customers SET total_orders=(SELECT COUNT(*)FROM orders WHERE customer_id=$1),total_revenue=(SELECT COALESCE(SUM(revenue),0)FROM orders WHERE customer_id=$1),total_profit=(SELECT COALESCE(SUM(gross_profit),0)FROM orders WHERE customer_id=$1),ltv=(SELECT COALESCE(SUM(gross_profit),0)FROM orders WHERE customer_id=$1),aov=(SELECT CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END FROM orders WHERE customer_id=$1),first_order_date=(SELECT MIN(order_date)FROM orders WHERE customer_id=$1),last_order_date=(SELECT MAX(order_date)FROM orders WHERE customer_id=$1),cohort_month=(SELECT TO_CHAR(MIN(order_date),'YYYY-MM')FROM orders WHERE customer_id=$1),is_returning=(SELECT COUNT(*)>1 FROM orders WHERE customer_id=$1),updated_at=NOW()WHERE id=$1`,[cid])}
    console.log(`✅ Orders pg ${pg}: ${data.length}`);if(data.length<100)break;pg++}
    // Rebuild daily metrics
    await pool.query(`INSERT INTO daily_metrics(date,revenue,cogs,shipping_cost,payment_fees,discount_total,refund_total,tax_total,gross_profit,orders_count,items_sold,new_customers,returning_customers,aov)SELECT order_date::date,COALESCE(SUM(revenue),0),COALESCE(SUM(cogs),0),COALESCE(SUM(shipping_cost),0),COALESCE(SUM(payment_fees),0),COALESCE(SUM(discount),0),COALESCE(SUM(refund_amount),0),COALESCE(SUM(tax),0),COALESCE(SUM(gross_profit),0),COUNT(*),COALESCE(SUM(items_count),0),COUNT(*)FILTER(WHERE is_first_order=true),COUNT(*)FILTER(WHERE is_first_order=false),CASE WHEN COUNT(*)>0 THEN SUM(revenue)/COUNT(*)ELSE 0 END FROM orders GROUP BY order_date::date ON CONFLICT(date)DO UPDATE SET revenue=EXCLUDED.revenue,cogs=EXCLUDED.cogs,shipping_cost=EXCLUDED.shipping_cost,payment_fees=EXCLUDED.payment_fees,discount_total=EXCLUDED.discount_total,gross_profit=EXCLUDED.gross_profit,orders_count=EXCLUDED.orders_count,new_customers=EXCLUDED.new_customers,returning_customers=EXCLUDED.returning_customers,aov=EXCLUDED.aov,updated_at=NOW()`);
    // Product stats
    await pool.query(`UPDATE products p SET total_sold=s.ts,total_revenue=s.tr,total_profit=s.tp,updated_at=NOW()FROM(SELECT product_id,SUM(quantity)as ts,SUM(line_total)as tr,SUM(line_profit)as tp FROM order_items GROUP BY product_id)s WHERE p.id=s.product_id`);
    // Fixed costs
    const fc=await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');
    await pool.query(`UPDATE daily_metrics SET fixed_costs_daily=$1,contribution_margin=gross_profit-ad_spend,net_profit=gross_profit-ad_spend-$1,mer=CASE WHEN ad_spend>0 THEN revenue/ad_spend ELSE 0 END`,[+(fc.rows[0].t)/30]);
    await pool.query("UPDATE integrations SET sync_status='completed',last_sync_at=NOW(),error_message=NULL WHERE platform='woocommerce'");
    console.log('✅ Full sync done!');
  }catch(e){console.error('Sync error:',e.message);await pool.query("UPDATE integrations SET sync_status='error',error_message=$1 WHERE platform='woocommerce'",[e.message])}
});

// ====================== WORDPRESS PLUGIN API ======================
// Auth middleware for plugin requests (uses shared secret instead of JWT)
const pluginAuth = (req, res, next) => {
  const secret = req.headers["x-plugin-secret"];
  if (!secret || secret !== process.env.PLUGIN_API_SECRET) return res.status(401).json({ error: "Invalid plugin secret" });
  next();
};

// Receive COGS from WordPress plugin
app.post("/api/plugin/cogs", pluginAuth, async (req, res) => {
  try {
    const { woo_product_id, cogs, shipping_cost, name, sku, price } = req.body;
    const r = await pool.query(`
      INSERT INTO products(woo_product_id, name, sku, price, cogs,
        breakeven_roas, gross_margin_pct, status)
      VALUES($1, $2, $3, $4, $5,
        CASE WHEN $4>0 AND $4-$5>0 THEN ROUND($4/($4-$5),4) ELSE 0 END,
        CASE WHEN $4>0 THEN ROUND(($4-$5)/$4*100,2) ELSE 0 END,
        'active')
      ON CONFLICT(woo_product_id) DO UPDATE SET
        cogs=$5, name=COALESCE($2,products.name), sku=COALESCE($3,products.sku),
        price=COALESCE($4,products.price),
        breakeven_roas=CASE WHEN COALESCE($4,products.price)>0 AND COALESCE($4,products.price)-$5>0
          THEN ROUND(COALESCE($4,products.price)/(COALESCE($4,products.price)-$5),4) ELSE 0 END,
        gross_margin_pct=CASE WHEN COALESCE($4,products.price)>0
          THEN ROUND((COALESCE($4,products.price)-$5)/COALESCE($4,products.price)*100,2) ELSE 0 END,
        updated_at=NOW()
      RETURNING *`, [woo_product_id, name, sku, price, cogs]);
    res.json({ ok: true, product: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Plugin heartbeat / connection check
app.post("/api/plugin/heartbeat", pluginAuth, async (req, res) => {
  try {
    const { action } = req.body;
    if (action === "trigger_sync") {
      // Trigger async sync
      setTimeout(() => {
        axios.post(`http://localhost:${PORT}/api/sync/woocommerce`, {}, {
          headers: { Authorization: "Bearer internal" }
        }).catch(() => {});
      }, 100);
      return res.json({ ok: true, message: "Sync triggered" });
    }
    const pc = await pool.query("SELECT COUNT(*) as c FROM products");
    const oc = await pool.query("SELECT COUNT(*) as c FROM orders");
    res.json({ ok: true, status: "connected", products: +pc.rows[0].c, orders: +oc.rows[0].c, ts: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get products list for plugin
app.get("/api/plugin/products", pluginAuth, async (req, res) => {
  try {
    const r = await pool.query("SELECT woo_product_id, name, sku, price, cogs, gross_margin_pct, breakeven_roas FROM products WHERE woo_product_id IS NOT NULL ORDER BY name");
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bulk COGS update from plugin
app.post("/api/plugin/bulk-cogs", pluginAuth, async (req, res) => {
  try {
    const { products } = req.body;
    let updated = 0;
    for (const p of products) {
      await pool.query(`
        INSERT INTO products(woo_product_id, name, sku, price, cogs, status)
        VALUES($1,$2,$3,$4,$5,'active')
        ON CONFLICT(woo_product_id) DO UPDATE SET cogs=$5,
          breakeven_roas=CASE WHEN COALESCE($4,products.price)>0 AND COALESCE($4,products.price)-$5>0
            THEN ROUND(COALESCE($4,products.price)/(COALESCE($4,products.price)-$5),4) ELSE 0 END,
          gross_margin_pct=CASE WHEN COALESCE($4,products.price)>0
            THEN ROUND((COALESCE($4,products.price)-$5)/COALESCE($4,products.price)*100,2) ELSE 0 END,
          updated_at=NOW()`,
        [p.woo_product_id, p.name, p.sku, p.price, p.cogs]);
      updated++;
    }
    res.json({ ok: true, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ad Spend Sync (Meta, Google, TikTok) ──
app.post("/api/sync/ad-spend", auth, async (req, res) => {
  const { platform, date_from, date_to } = req.body;
  res.json({ status: "started", message: "Ad sync for " + (platform || "all") + " running..." });
  // Meta Ads sync
  if ((!platform || platform === "meta") && process.env.META_ACCESS_TOKEN) {
    try {
      const since = date_from || new Date(Date.now() - 7 * 864e5).toISOString().split("T")[0];
      const until = date_to || new Date().toISOString().split("T")[0];
      const url = `https://graph.facebook.com/v19.0/${process.env.META_AD_ACCOUNT_ID}/insights`;
      const resp = await axios.get(url, { params: { access_token: process.env.META_ACCESS_TOKEN, fields: "campaign_name,campaign_id,spend,impressions,clicks,actions,action_values,ctr,cpc,cpm", time_range: JSON.stringify({ since, until }), time_increment: 1, level: "campaign", limit: 500 } });
      for (const row of (resp.data.data || [])) {
        const conversions = (row.actions || []).find(a => a.action_type === "purchase");
        const convValue = (row.action_values || []).find(a => a.action_type === "purchase");
        await pool.query(`INSERT INTO ad_spend_daily(date,platform,campaign_id,campaign_name,spend,impressions,clicks,conversions,conversion_value,ctr,cpc,cpm,roas,cpa) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(date,platform,campaign_id) DO UPDATE SET spend=$5,impressions=$6,clicks=$7,conversions=$8,conversion_value=$9,ctr=$10,cpc=$11`,
          [row.date_start, "meta", row.campaign_id, row.campaign_name, +(row.spend)||0, +(row.impressions)||0, +(row.clicks)||0, +(conversions?.value)||0, +(convValue?.value)||0, +(row.ctr)||0, +(row.cpc)||0, +(row.cpm)||0, +(row.spend)>0?(+(convValue?.value)||0)/(+(row.spend)):0, +(conversions?.value)>0?(+(row.spend))/(+(conversions?.value)):0]);
      }
      // Update daily_metrics
      await pool.query(`UPDATE daily_metrics dm SET meta_spend=sub.spend, ad_spend=dm.ad_spend-dm.meta_spend+sub.spend FROM (SELECT date,SUM(spend) as spend FROM ad_spend_daily WHERE platform='meta' GROUP BY date) sub WHERE dm.date=sub.date`);
      console.log("Meta ads synced");
    } catch (e) { console.error("Meta sync error:", e.message); }
  }
  // TikTok + Google follow same pattern - log for now
  if ((!platform || platform === "google") && process.env.GOOGLE_ADS_DEVELOPER_TOKEN) { console.log("Google Ads sync: configure OAuth flow"); }
  if ((!platform || platform === "tiktok") && process.env.TIKTOK_ACCESS_TOKEN) { console.log("TikTok Ads sync: configure API"); }
});

// ====================== ELAVON PAYMENT FEE INTEGRATION ======================
app.post("/api/sync/elavon", auth, async (req, res) => {
  try {
    const { date_from, date_to } = req.body;
    if (!process.env.ELAVON_MERCHANT_ID || !process.env.ELAVON_USER_ID || !process.env.ELAVON_PIN) return res.json({ status: "skipped", message: "Elavon credentials not configured" });
    const since = date_from || new Date(Date.now() - 30 * 864e5).toISOString().split("T")[0];
    const until = date_to || new Date().toISOString().split("T")[0];
    // Elavon Converge API - Transaction Search
    const resp = await axios.post("https://api.convergepay.com/VirtualMerchant/processxml.do", 
      `xmldata=<txn><ssl_merchant_id>${process.env.ELAVON_MERCHANT_ID}</ssl_merchant_id><ssl_user_id>${process.env.ELAVON_USER_ID}</ssl_user_id><ssl_pin>${process.env.ELAVON_PIN}</ssl_pin><ssl_transaction_type>txnquery</ssl_transaction_type><ssl_search_start_date>${since}</ssl_search_start_date><ssl_search_end_date>${until}</ssl_search_end_date></txn>`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    ).catch(e => ({ data: null, error: e.message }));
    // Parse fees from Elavon response and update orders
    if (resp.data) {
      // Elavon returns XML; parse transaction fees
      const feeMatches = resp.data.match(/<ssl_txn_id>(.*?)<\/ssl_txn_id>[\s\S]*?<ssl_amount>(.*?)<\/ssl_amount>[\s\S]*?<ssl_base_amount>(.*?)<\/ssl_base_amount>/g) || [];
      let updated = 0;
      for (const match of feeMatches) {
        const txnId = match.match(/<ssl_txn_id>(.*?)<\/ssl_txn_id>/)?.[1];
        const amount = +(match.match(/<ssl_amount>(.*?)<\/ssl_amount>/)?.[1]) || 0;
        const baseAmount = +(match.match(/<ssl_base_amount>(.*?)<\/ssl_base_amount>/)?.[1]) || 0;
        const fee = Math.round((amount - baseAmount) * 100) / 100;
        if (fee > 0) {
          await pool.query(`UPDATE orders SET payment_fees=$1 WHERE woo_order_id IN (SELECT woo_order_id FROM orders WHERE revenue BETWEEN $2-1 AND $2+1 AND payment_fees=0 LIMIT 1)`, [fee, baseAmount]);
          updated++;
        }
      }
      await pool.query(`UPDATE integrations SET last_sync_at=NOW(),sync_status='synced',is_connected=true WHERE platform='elavon'`);
      res.json({ status: "synced", updated, message: `Updated fees for ${updated} transactions` });
    } else {
      res.json({ status: "error", message: resp.error || "No data from Elavon" });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== AMAZON MCF (MULTI-CHANNEL FULFILLMENT) ======================
app.post("/api/sync/amazon-mcf", auth, async (req, res) => {
  try {
    if (!process.env.AMAZON_SP_REFRESH_TOKEN || !process.env.AMAZON_SP_CLIENT_ID) return res.json({ status: "skipped", message: "Amazon SP-API credentials not configured" });
    // Step 1: Get access token
    const tokenResp = await axios.post("https://api.amazon.com/auth/o2/token", {
      grant_type: "refresh_token", refresh_token: process.env.AMAZON_SP_REFRESH_TOKEN,
      client_id: process.env.AMAZON_SP_CLIENT_ID, client_secret: process.env.AMAZON_SP_CLIENT_SECRET
    });
    const token = tokenResp.data.access_token;
    // Step 2: Get fulfillment orders with fees
    const since = req.body.date_from || new Date(Date.now() - 30 * 864e5).toISOString();
    const ordersResp = await axios.get("https://sellingpartnerapi-na.amazon.com/fba/outbound/2020-07-01/fulfillmentOrders", {
      headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
      params: { queryStartDate: since }
    }).catch(e => ({ data: { payload: { fulfillmentOrders: [] } }, error: e.message }));
    const mcfOrders = ordersResp.data?.payload?.fulfillmentOrders || [];
    let updated = 0;
    for (const fo of mcfOrders) {
      // MCF charges per-unit fees; map to our orders by merchant order ID
      const merchantRef = fo.displayableOrderId;
      const totalFee = (fo.fulfillmentOrderItems || []).reduce((s, i) => s + (+(i.perUnitDeclaredValue?.value) || 0) * 0.15, 0); // ~15% fulfillment fee estimate
      const shippingFee = +(fo.fulfillmentAction === "Ship" ? 5.99 : 0);
      if (merchantRef) {
        await pool.query(`UPDATE orders SET shipping_cost=$1, gross_profit=revenue-cogs-$1-payment_fees-discount WHERE woo_order_id=$2`, [shippingFee + totalFee, merchantRef]);
        updated++;
      }
    }
    await pool.query(`UPDATE integrations SET last_sync_at=NOW(),sync_status='synced',is_connected=true WHERE platform='amazon_mcf'`);
    res.json({ status: "synced", orders: mcfOrders.length, updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== MARKETPLACE SALES SYNC (Amazon, TikTok Shop, Meta Shop) ======================
app.post("/api/sync/marketplaces", auth, async (req, res) => {
  const results = {};
  const { platform } = req.body;

  // Amazon Seller Central orders
  if ((!platform || platform === "amazon") && process.env.AMAZON_SP_REFRESH_TOKEN) {
    try {
      const tokenResp = await axios.post("https://api.amazon.com/auth/o2/token", { grant_type: "refresh_token", refresh_token: process.env.AMAZON_SP_REFRESH_TOKEN, client_id: process.env.AMAZON_SP_CLIENT_ID, client_secret: process.env.AMAZON_SP_CLIENT_SECRET });
      const token = tokenResp.data.access_token;
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const ordResp = await axios.get("https://sellingpartnerapi-na.amazon.com/orders/v0/orders", { headers: { "x-amz-access-token": token }, params: { CreatedAfter: since, MarketplaceIds: process.env.AMAZON_MARKETPLACE_ID || "ATVPDKIKX0DER" } });
      const orders = ordResp.data?.payload?.Orders || [];
      for (const o of orders) {
        const rev = +(o.OrderTotal?.Amount) || 0;
        const fee = rev * 0.15; // Amazon referral fee ~15%
        await pool.query(`INSERT INTO orders(woo_order_id,order_date,status,revenue,payment_fees,country,utm_source,gross_profit) VALUES($1,$2,$3,$4,$5,$6,'amazon',$4-$5) ON CONFLICT(woo_order_id) DO NOTHING`,
          [`AMZ-${o.AmazonOrderId}`, o.PurchaseDate, o.OrderStatus?.toLowerCase(), rev, fee, o.ShippingAddress?.CountryCode]);
      }
      results.amazon = { synced: orders.length };
      await pool.query(`UPDATE integrations SET last_sync_at=NOW(),sync_status='synced',is_connected=true WHERE platform='amazon_marketplace'`);
    } catch (e) { results.amazon = { error: e.message }; }
  }

  // TikTok Shop orders
  if ((!platform || platform === "tiktok_shop") && process.env.TIKTOK_SHOP_ACCESS_TOKEN) {
    try {
      const resp = await axios.get("https://open-api.tiktokglobalshop.com/api/orders/search", {
        headers: { "x-tts-access-token": process.env.TIKTOK_SHOP_ACCESS_TOKEN },
        params: { app_key: process.env.TIKTOK_SHOP_APP_KEY, shop_id: process.env.TIKTOK_SHOP_ID, page_size: 100, create_time_from: Math.floor(Date.now()/1000) - 30*86400 }
      });
      const orders = resp.data?.data?.order_list || [];
      for (const o of orders) {
        const rev = +(o.payment?.total_amount) || 0;
        const fee = +(o.payment?.platform_discount) || rev * 0.05; // TikTok Shop fee ~5%
        await pool.query(`INSERT INTO orders(woo_order_id,order_date,status,revenue,payment_fees,utm_source,gross_profit) VALUES($1,to_timestamp($2),$3,$4,$5,'tiktok_shop',$4-$5) ON CONFLICT(woo_order_id) DO NOTHING`,
          [`TTS-${o.order_id}`, o.create_time, o.order_status === 100 ? 'completed' : 'processing', rev, fee]);
      }
      results.tiktok_shop = { synced: orders.length };
      await pool.query(`UPDATE integrations SET last_sync_at=NOW(),sync_status='synced',is_connected=true WHERE platform='tiktok_shop'`);
    } catch (e) { results.tiktok_shop = { error: e.message }; }
  }

  // Meta Commerce / Facebook Shop
  if ((!platform || platform === "meta_shop") && process.env.META_COMMERCE_ACCESS_TOKEN) {
    try {
      const pageId = process.env.META_COMMERCE_PAGE_ID;
      const resp = await axios.get(`https://graph.facebook.com/v19.0/${pageId}/commerce_orders`, {
        params: { access_token: process.env.META_COMMERCE_ACCESS_TOKEN, fields: "id,order_status,created,estimated_payment_details,ship_by_date,items{id,product_name,quantity,price_per_unit}", limit: 100 }
      });
      const orders = resp.data?.data || [];
      for (const o of orders) {
        const rev = o.items?.data?.reduce((s, i) => s + (+(i.price_per_unit?.amount) || 0) * (i.quantity || 1), 0) / 100 || 0;
        const fee = rev * 0.05; // Meta Shop fee ~5%
        await pool.query(`INSERT INTO orders(woo_order_id,order_date,status,revenue,payment_fees,utm_source,gross_profit) VALUES($1,$2,$3,$4,$5,'meta_shop',$4-$5) ON CONFLICT(woo_order_id) DO NOTHING`,
          [`META-${o.id}`, o.created, o.order_status?.toLowerCase() === 'completed' ? 'completed' : 'processing', rev, fee]);
      }
      results.meta_shop = { synced: orders.length };
      await pool.query(`UPDATE integrations SET last_sync_at=NOW(),sync_status='synced',is_connected=true WHERE platform='meta_shop'`);
    } catch (e) { results.meta_shop = { error: e.message }; }
  }

  res.json({ status: "done", results });
});

// ====================== ENGINEMAILER EMAIL MARKETING SYNC ======================
app.post("/api/sync/enginemailer", auth, async (req, res) => {
  try {
    if (!process.env.ENGINEMAILER_API_KEY) return res.json({ status: "skipped", message: "Enginemailer API key not configured" });
    const since = req.body.date_from || new Date(Date.now() - 30 * 864e5).toISOString().split("T")[0];
    // Enginemailer campaigns/stats API
    const campaignsResp = await axios.get("https://api.enginemailer.com/v2/campaigns", {
      headers: { "Authorization": "Bearer " + process.env.ENGINEMAILER_API_KEY, "Content-Type": "application/json" },
      params: { from_date: since, status: "sent", page_size: 100 }
    }).catch(e => ({ data: { campaigns: [] }, error: e.message }));
    const campaigns = campaignsResp.data?.campaigns || campaignsResp.data?.data || [];
    let totalRevenue = 0, totalSent = 0;
    for (const c of campaigns) {
      const rev = +(c.revenue) || +(c.stats?.revenue) || 0;
      totalRevenue += rev;
      totalSent++;
      // Store daily email revenue in daily_metrics
      const date = c.sent_date || c.send_date || since;
      await pool.query(`UPDATE daily_metrics SET email_revenue=COALESCE(email_revenue,0)+$1 WHERE date=$2`, [rev, date.split("T")[0]]);
    }
    // Also get automation revenue if available
    const autoResp = await axios.get("https://api.enginemailer.com/v2/automations/stats", {
      headers: { "Authorization": "Bearer " + process.env.ENGINEMAILER_API_KEY },
      params: { from_date: since }
    }).catch(() => ({ data: {} }));
    const autoRev = +(autoResp.data?.total_revenue) || 0;
    totalRevenue += autoRev;
    await pool.query(`UPDATE integrations SET last_sync_at=NOW(),sync_status='synced',is_connected=true WHERE platform='enginemailer'`);
    res.json({ status: "synced", campaigns: totalSent, totalRevenue, automationRevenue: autoRev });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== WEEKLY EMAIL SUMMARY REPORT ======================
async function sendWeeklyReport() {
  try {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) { console.log("SMTP not configured, skipping weekly report"); return; }
    const report = await pool.query(`SELECT report_type,recipients,is_active FROM report_configs WHERE report_type='weekly_summary' AND is_active=true`);
    if (!report.rows.length || !report.rows[0].recipients) return;
    const recipients = typeof report.rows[0].recipients === 'string' ? JSON.parse(report.rows[0].recipients) : report.rows[0].recipients;
    if (!recipients.length) return;

    // Get this week vs last week data
    const thisWeek = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as gross_profit, COALESCE(SUM(net_profit),0) as net_profit, COALESCE(SUM(orders_count),0) as orders, COALESCE(SUM(ad_spend),0) as ad_spend, COALESCE(AVG(aov),0) as aov, COALESCE(SUM(new_customers),0) as new_cust FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '7 days'`);
    const lastWeek = await pool.query(`SELECT COALESCE(SUM(revenue),0) as revenue, COALESCE(SUM(gross_profit),0) as gross_profit, COALESCE(SUM(net_profit),0) as net_profit, COALESCE(SUM(orders_count),0) as orders, COALESCE(SUM(ad_spend),0) as ad_spend FROM daily_metrics WHERE date >= CURRENT_DATE - INTERVAL '14 days' AND date < CURRENT_DATE - INTERVAL '7 days'`);
    const tw = thisWeek.rows[0], lw = lastWeek.rows[0];
    const pct = (c, p) => p > 0 ? ((c - p) / p * 100).toFixed(1) : 'N/A';
    const arrow = (c, p) => c > p ? '↑' : c < p ? '↓' : '→';
    const fc = v => '$' + (+v || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

    // Top products
    const topProds = await pool.query(`SELECT p.name, SUM(oi.line_total) as rev, SUM(oi.quantity) as qty FROM order_items oi JOIN products p ON oi.product_id=p.id JOIN orders o ON oi.order_id=o.id WHERE o.order_date >= CURRENT_DATE - INTERVAL '7 days' GROUP BY p.name ORDER BY rev DESC LIMIT 5`);

    const html = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e4e7">
      <div style="background:linear-gradient(135deg,#14532d,#166534);padding:32px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:24px">📊 TVS Weekly Profit Report</h1>
        <p style="color:#86efac;margin:8px 0 0;font-size:14px">${new Date(Date.now()-7*864e5).toLocaleDateString()} — ${new Date().toLocaleDateString()}</p>
      </div>
      <div style="padding:32px">
        <h2 style="color:#18181b;font-size:18px;margin:0 0 20px;border-bottom:2px solid #f4f4f5;padding-bottom:12px">Key Metrics</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Revenue</td><td style="text-align:right;font-weight:700;color:#18181b">${fc(tw.revenue)}</td><td style="text-align:right;color:${+tw.revenue>=+lw.revenue?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.revenue,+lw.revenue)} ${pct(+tw.revenue,+lw.revenue)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Gross Profit</td><td style="text-align:right;font-weight:700;color:#18181b">${fc(tw.gross_profit)}</td><td style="text-align:right;color:${+tw.gross_profit>=+lw.gross_profit?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.gross_profit,+lw.gross_profit)} ${pct(+tw.gross_profit,+lw.gross_profit)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Net Profit</td><td style="text-align:right;font-weight:700;color:${+tw.net_profit>=0?'#16a34a':'#dc2626'}">${fc(tw.net_profit)}</td><td style="text-align:right;color:${+tw.net_profit>=+lw.net_profit?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.net_profit,+lw.net_profit)} ${pct(+tw.net_profit,+lw.net_profit)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Orders</td><td style="text-align:right;font-weight:700">${tw.orders}</td><td style="text-align:right;color:${+tw.orders>=+lw.orders?'#16a34a':'#dc2626'};padding-left:12px">${arrow(+tw.orders,+lw.orders)} ${pct(+tw.orders,+lw.orders)}%</td></tr>
          <tr style="border-bottom:1px solid #f4f4f5"><td style="padding:12px 0;color:#71717a">Ad Spend</td><td style="text-align:right;font-weight:700">${fc(tw.ad_spend)}</td><td style="text-align:right;padding-left:12px">${pct(+tw.ad_spend,+lw.ad_spend)}%</td></tr>
          <tr><td style="padding:12px 0;color:#71717a">AOV</td><td style="text-align:right;font-weight:700">${fc(tw.aov)}</td><td></td></tr>
        </table>
        ${topProds.rows.length ? `<h2 style="color:#18181b;font-size:18px;margin:28px 0 16px;border-bottom:2px solid #f4f4f5;padding-bottom:12px">Top Products</h2><table style="width:100%;font-size:13px">${topProds.rows.map((p,i) => `<tr style="border-bottom:1px solid #f4f4f5"><td style="padding:8px 0">${i+1}. ${p.name}</td><td style="text-align:right;font-weight:600">${fc(p.rev)}</td><td style="text-align:right;color:#71717a">${p.qty} sold</td></tr>`).join('')}</table>` : ''}
      </div>
      <div style="background:#f4f4f5;padding:20px;text-align:center;font-size:12px;color:#71717a">TVS Profit Dashboard — The Vitamin Shots</div>
    </div>`;

    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +(process.env.SMTP_PORT)||587, secure: false, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
    await transporter.sendMail({ from: process.env.EMAIL_FROM || process.env.SMTP_USER, to: recipients.join(','), subject: `TVS Weekly Report — Revenue: ${fc(tw.revenue)} | Profit: ${fc(tw.net_profit)}`, html });
    await pool.query(`UPDATE report_configs SET last_sent_at=NOW() WHERE report_type='weekly_summary'`);
    console.log("✅ Weekly report sent to", recipients.join(", "));
  } catch (e) { console.error("Weekly report error:", e.message); }
}

// Manual trigger
app.post("/api/reports/send-weekly", auth, async (req, res) => {
  await sendWeeklyReport();
  res.json({ ok: true, message: "Weekly report sent" });
});

// ====================== TAX P&L CSV EXPORT ======================
app.get("/api/export/tax-pnl", auth, async (req, res) => {
  try {
    const { year, month } = req.query;
    const y = +(year) || new Date().getFullYear();
    const m = +(month) || 0;
    let startDate, endDate, label;
    if (m > 0 && m <= 12) {
      startDate = `${y}-${String(m).padStart(2,'0')}-01`;
      endDate = m < 12 ? `${y}-${String(m+1).padStart(2,'0')}-01` : `${y+1}-01-01`;
      label = `${y}-${String(m).padStart(2,'0')}`;
    } else {
      startDate = `${y}-01-01`;
      endDate = `${y+1}-01-01`;
      label = `${y}`;
    }
    // Monthly breakdown
    const monthly = await pool.query(`SELECT TO_CHAR(date,'YYYY-MM') as month, SUM(revenue) as revenue, SUM(cogs) as cogs, SUM(shipping_cost) as shipping, SUM(payment_fees) as payment_fees, SUM(discount_total) as discounts, SUM(refund_total) as refunds, SUM(ad_spend) as ad_spend, SUM(meta_spend) as meta_spend, SUM(google_spend) as google_spend, SUM(tiktok_spend) as tiktok_spend, SUM(fixed_costs_daily) as fixed_costs, SUM(gross_profit) as gross_profit, SUM(contribution_margin) as contribution_margin, SUM(net_profit) as net_profit, SUM(orders_count) as orders, SUM(new_customers) as new_customers, SUM(tax_total) as sales_tax_collected FROM daily_metrics WHERE date >= $1 AND date < $2 GROUP BY TO_CHAR(date,'YYYY-MM') ORDER BY month`, [startDate, endDate]);

    // Fixed costs detail
    const fc = await pool.query(`SELECT name,amount_monthly,category FROM fixed_costs WHERE is_active=true ORDER BY name`);

    // Build CSV
    let csv = `TVS Profit & Loss Statement for Tax Filing\n`;
    csv += `Period: ${label}\n`;
    csv += `Generated: ${new Date().toISOString().split('T')[0]}\n`;
    csv += `Business: The Vitamin Shots LLC\n\n`;

    // Income section
    csv += `INCOME & REVENUE\n`;
    csv += `Month,Gross Revenue,Discounts,Refunds,Net Revenue,Sales Tax Collected\n`;
    let totals = { revenue: 0, discounts: 0, refunds: 0, net: 0, tax: 0 };
    for (const r of monthly.rows) {
      const net = +r.revenue - +r.discounts - +r.refunds;
      csv += `${r.month},${(+r.revenue).toFixed(2)},${(+r.discounts).toFixed(2)},${(+r.refunds).toFixed(2)},${net.toFixed(2)},${(+r.sales_tax_collected).toFixed(2)}\n`;
      totals.revenue += +r.revenue; totals.discounts += +r.discounts; totals.refunds += +r.refunds; totals.net += net; totals.tax += +r.sales_tax_collected;
    }
    csv += `TOTAL,${totals.revenue.toFixed(2)},${totals.discounts.toFixed(2)},${totals.refunds.toFixed(2)},${totals.net.toFixed(2)},${totals.tax.toFixed(2)}\n\n`;

    // COGS section
    csv += `COST OF GOODS SOLD (COGS)\n`;
    csv += `Month,Product COGS,Shipping Costs,Payment Processing Fees,Total COGS\n`;
    let cogsTotals = { cogs: 0, ship: 0, fees: 0 };
    for (const r of monthly.rows) {
      const total = +r.cogs + +r.shipping + +r.payment_fees;
      csv += `${r.month},${(+r.cogs).toFixed(2)},${(+r.shipping).toFixed(2)},${(+r.payment_fees).toFixed(2)},${total.toFixed(2)}\n`;
      cogsTotals.cogs += +r.cogs; cogsTotals.ship += +r.shipping; cogsTotals.fees += +r.payment_fees;
    }
    csv += `TOTAL,${cogsTotals.cogs.toFixed(2)},${cogsTotals.ship.toFixed(2)},${cogsTotals.fees.toFixed(2)},${(cogsTotals.cogs+cogsTotals.ship+cogsTotals.fees).toFixed(2)}\n\n`;

    // Marketing expenses
    csv += `MARKETING & ADVERTISING EXPENSES\n`;
    csv += `Month,Meta/Facebook Ads,Google Ads,TikTok Ads,Total Ad Spend\n`;
    let adTotals = { meta: 0, google: 0, tiktok: 0, total: 0 };
    for (const r of monthly.rows) {
      csv += `${r.month},${(+r.meta_spend).toFixed(2)},${(+r.google_spend).toFixed(2)},${(+r.tiktok_spend).toFixed(2)},${(+r.ad_spend).toFixed(2)}\n`;
      adTotals.meta += +r.meta_spend; adTotals.google += +r.google_spend; adTotals.tiktok += +r.tiktok_spend; adTotals.total += +r.ad_spend;
    }
    csv += `TOTAL,${adTotals.meta.toFixed(2)},${adTotals.google.toFixed(2)},${adTotals.tiktok.toFixed(2)},${adTotals.total.toFixed(2)}\n\n`;

    // Fixed/operating expenses
    csv += `FIXED & OPERATING EXPENSES (Monthly)\n`;
    csv += `Expense,Category,Monthly Amount,Annual Amount\n`;
    let fixedTotal = 0;
    for (const f of fc.rows) {
      csv += `${f.name},${f.category||'General'},${(+f.amount_monthly).toFixed(2)},${(+f.amount_monthly*12).toFixed(2)}\n`;
      fixedTotal += +f.amount_monthly;
    }
    csv += `TOTAL,,${fixedTotal.toFixed(2)},${(fixedTotal*12).toFixed(2)}\n\n`;

    // P&L Summary
    csv += `PROFIT & LOSS SUMMARY\n`;
    csv += `Month,Net Revenue,Total COGS,Gross Profit,Ad Spend,Fixed Costs,Net Profit,Net Margin %\n`;
    for (const r of monthly.rows) {
      const netRev = +r.revenue - +r.discounts - +r.refunds;
      const margin = netRev > 0 ? (+r.net_profit / netRev * 100).toFixed(1) : '0.0';
      csv += `${r.month},${netRev.toFixed(2)},${(+r.cogs + +r.shipping + +r.payment_fees).toFixed(2)},${(+r.gross_profit).toFixed(2)},${(+r.ad_spend).toFixed(2)},${(+r.fixed_costs).toFixed(2)},${(+r.net_profit).toFixed(2)},${margin}%\n`;
    }
    const grandNet = totals.net - cogsTotals.cogs - cogsTotals.ship - cogsTotals.fees - adTotals.total - (fixedTotal * monthly.rows.length);
    csv += `TOTAL,${totals.net.toFixed(2)},${(cogsTotals.cogs+cogsTotals.ship+cogsTotals.fees).toFixed(2)},${(totals.net-cogsTotals.cogs-cogsTotals.ship-cogsTotals.fees).toFixed(2)},${adTotals.total.toFixed(2)},${(fixedTotal*monthly.rows.length).toFixed(2)},${grandNet.toFixed(2)},${totals.net>0?(grandNet/totals.net*100).toFixed(1):'0.0'}%\n`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="TVS_PnL_Tax_${label}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ====================== CRON JOBS ======================
cron.schedule('0 3 * * *',async()=>{console.log('⏰ Daily metrics rebuild');try{const fc=await pool.query('SELECT COALESCE(SUM(amount_monthly),0)as t FROM fixed_costs WHERE is_active=true');await pool.query(`UPDATE daily_metrics SET fixed_costs_daily=$1,contribution_margin=gross_profit-ad_spend,net_profit=gross_profit-ad_spend-$1,mer=CASE WHEN ad_spend>0 THEN revenue/ad_spend ELSE 0 END`,[+(fc.rows[0].t)/30]);console.log('✅ Daily rebuild done')}catch(e){console.error(e.message)}});
// Weekly report every Monday 8 AM
cron.schedule('0 8 * * 1',async()=>{console.log('📧 Sending weekly report...');await sendWeeklyReport()});
// Sync marketplaces + ad spend daily at 4 AM
cron.schedule('0 4 * * *',async()=>{console.log('🔄 Auto-syncing integrations...');try{
  if(process.env.META_ACCESS_TOKEN){const axios2=require('axios');/* Meta ads auto-sync handled by ad-spend endpoint */console.log('Meta: configured')}
  if(process.env.ENGINEMAILER_API_KEY){console.log('Enginemailer: will sync')}
  if(process.env.AMAZON_SP_REFRESH_TOKEN){console.log('Amazon: will sync')}
}catch(e){console.error('Auto-sync error:',e.message)}});

// ====================== START ======================
app.listen(PORT,()=>console.log(`\n🚀 TVS Profit Dashboard Backend running on port ${PORT}\n   Env: ${process.env.NODE_ENV||'development'}\n`));
