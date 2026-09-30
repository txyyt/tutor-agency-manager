-- reviewing 的旧存储值改为仅代表待结算；不再维护家长挑选阶段。
UPDATE orders SET status = 'recruiting', version = version + 1
WHERE status = 'reviewing' AND current_application_id IS NULL;
UPDATE orders SET paused_from_status = 'recruiting'
WHERE paused_from_status = 'reviewing';
UPDATE applications SET cooperation_confirmed_at = updated_at, version = version + 1
WHERE status = 'trial_passed' AND cooperation_confirmed_at IS NULL;
UPDATE orders SET location_detail = '线上', public_area = '线上', version = version + 1
WHERE teaching_mode = 'online' AND (location_detail != '线上' OR public_area != '线上');
